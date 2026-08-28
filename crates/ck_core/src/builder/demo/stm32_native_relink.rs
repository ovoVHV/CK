//! Isolated STM32 `OrderedImmutableObjects + CoreArchive` NativeRelink engine.
//!
//! This Phase 1 module is intentionally not wired into `demo.rs`, the desktop
//! command surface, Forge qualification, or upload.  It captures and rechecks
//! the actual Arduino CLI graph for the qualified NUCLEO_F401RE sample instead
//! of assuming the AVR/SAMD link shape.  Product integration must remain behind
//! an identity-bound local performance certificate.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

pub(crate) const STM32_NATIVE_RELINK_SCHEMA_VERSION: u32 = 1;
pub(crate) const STM32_NATIVE_RELINK_ENGINE_CONTRACT: &str =
    "ck-native-relink-stm32-ordered-objects-release-compile-only-phase1-v1";
pub(crate) const STM32_NATIVE_RELINK_CAPABILITY_CLASS: &str =
    "stm32-ordered-immutable-objects-plus-core-archive-v1";
pub(crate) const STM32_NATIVE_RELINK_ACCESS_CONTRACT: &str = "ck-native-relink-access-key-v1";
pub(crate) const STM32_TRANSLATION_PROOF_CONTRACT: &str =
    "ck-direct-cpp-no-auto-prototypes-proof-v1";
pub(crate) const STM32_PHASE1_FQBN: &str = "STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE";
pub(crate) const STM32_PHASE1_CORE_VERSION: &str = "2.12.0";

const EXPECTED_CCDB_ENTRIES: usize = 212;
const EXPECTED_ORDERED_OBJECTS: usize = 188;
const EXPECTED_IMMUTABLE_OBJECTS: usize = 187;
const EXPECTED_ARCHIVE_MEMBERS: usize = 24;
const EXPECTED_SKETCH_CCDB_ENTRIES: usize = 2;
const EXPECTED_LIBRARY_CCDB_ENTRIES: usize = 180;
const EXPECTED_CORE_CCDB_ENTRIES: usize = 30;
const MAX_IDENTITY_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DEPFILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PROJECT_NAME_BYTES: usize = 128;
static TEMP_NONCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Stm32CompileIntent {
    CompileOnly,
    UploadReady,
    Background,
    LockedReplay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Stm32GateCode {
    IntentDenied,
    ProfileDenied,
    ThirdPartyLibrariesDenied,
    InvalidAccessKey,
    InvalidManifest,
    InvalidPath,
    UnsafeFilesystemEntry,
    MissingFile,
    EmptyFile,
    FileTooLarge,
    CcdbMismatch,
    CommandGraphMismatch,
    UnsupportedCapabilityGraph,
    ToolOutsideManagedRoot,
    TranslationUnsupported,
    DependencyMismatch,
    DirtyBuild,
    Cancelled,
    ExecutionFailed,
    ArtifactSealFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Stm32GateError {
    pub code: Stm32GateCode,
    pub detail: String,
}

impl Stm32GateError {
    fn new(code: Stm32GateCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for Stm32GateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.detail)
    }
}

impl std::error::Error for Stm32GateError {}

type GateResult<T> = Result<T, Stm32GateError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Stm32FileIdentity {
    pub relative_path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Stm32ExternalFileIdentity {
    pub canonical_path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Stm32AccessBinding {
    pub contract: String,
    pub mode: String,
    pub authorization_key: String,
    pub canonical_fqbn: String,
    pub core_version: String,
    pub cli_version: String,
    pub toolchain_key: String,
    pub property_contract_sha256: String,
}

impl Stm32AccessBinding {
    fn validate(&self) -> GateResult<()> {
        if self.contract != STM32_NATIVE_RELINK_ACCESS_CONTRACT
            || !matches!(self.mode.as_str(), "qualification-probe" | "certified")
            || self.canonical_fqbn != STM32_PHASE1_FQBN
            || self.core_version != STM32_PHASE1_CORE_VERSION
            || self.cli_version.trim().is_empty()
            || self.toolchain_key.trim().is_empty()
            || !is_sha256_hex(&self.authorization_key)
            || !is_sha256_hex(&self.property_contract_sha256)
        {
            return Err(Stm32GateError::new(
                Stm32GateCode::InvalidAccessKey,
                "STM32 access binding is incomplete or outside the Phase 1 identity",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Stm32TranslationProof {
    pub contract: String,
    pub source_sha256: String,
    pub analyzer_identity_sha256: String,
    pub functions_declared_before_use: bool,
    pub normalized_headers: Vec<String>,
}

impl Stm32TranslationProof {
    fn validate(&self, source: &str) -> GateResult<()> {
        if self.contract != STM32_TRANSLATION_PROOF_CONTRACT
            || self.source_sha256 != sha256_bytes(source.as_bytes())
            || !is_sha256_hex(&self.analyzer_identity_sha256)
            || !self.functions_declared_before_use
            || self.normalized_headers != ["arduino.h"]
        {
            return Err(Stm32GateError::new(
                Stm32GateCode::TranslationUnsupported,
                "trusted direct-C++ translation proof is missing or stale",
            ));
        }
        let includes = source
            .lines()
            .filter_map(|line| line.trim().strip_prefix("#include").map(str::trim))
            .map(|header| {
                header
                    .trim_matches(|character| matches!(character, '<' | '>' | '"'))
                    .to_ascii_lowercase()
            })
            .collect::<Vec<_>>();
        if includes != ["arduino.h"]
            || !source.contains("void setup")
            || !source.contains("void loop")
            || source.contains("__FILE__")
            || source.contains("__BASE_FILE__")
            || source.contains("#line")
        {
            return Err(Stm32GateError::new(
                Stm32GateCode::TranslationUnsupported,
                "Phase 1 requires Arduino.h, setup()/loop(), and path-independent source",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Stm32CommandRole {
    CompileSketch,
    Link,
    ObjcopyBin,
    ObjcopyHex,
    Size,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Stm32CommandSpec {
    pub role: Stm32CommandRole,
    pub working_directory: PathBuf,
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Stm32CommandGraph {
    pub compile_sketch: Stm32CommandSpec,
    pub link: Stm32CommandSpec,
    pub objcopy_bin: Stm32CommandSpec,
    pub objcopy_hex: Stm32CommandSpec,
    pub size: Stm32CommandSpec,
}

impl Stm32CommandGraph {
    fn ordered(&self) -> [&Stm32CommandSpec; 5] {
        [
            &self.compile_sketch,
            &self.link,
            &self.objcopy_bin,
            &self.objcopy_hex,
            &self.size,
        ]
    }

    fn sha256(&self) -> GateResult<String> {
        let bytes = serde_json::to_vec(self).map_err(|error| {
            Stm32GateError::new(
                Stm32GateCode::CommandGraphMismatch,
                format!("cannot serialize command graph: {error}"),
            )
        })?;
        Ok(sha256_bytes(&bytes))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Stm32MutableSeal {
    pub generated_cpp: Stm32FileIdentity,
    pub sketch_object: Stm32FileIdentity,
    pub sketch_depfile: Stm32FileIdentity,
    pub map: Stm32FileIdentity,
    pub elf: Stm32FileIdentity,
    pub bin: Stm32FileIdentity,
    pub hex: Stm32FileIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Stm32NativeRelinkManifest {
    pub schema_version: u32,
    pub engine_contract: String,
    pub capability_class: String,
    pub access: Stm32AccessBinding,
    pub project_name: String,
    pub sketch_ino_path: String,
    pub source_sha256: String,
    pub build_root: String,
    pub core_root: String,
    pub toolchain_root: String,
    pub ccdb: Stm32FileIdentity,
    pub build_options: Stm32FileIdentity,
    pub build_opt: Stm32FileIdentity,
    pub ordered_link_objects: Vec<Stm32FileIdentity>,
    pub immutable_link_objects: Vec<Stm32FileIdentity>,
    pub archived_ccdb_objects: Vec<Stm32FileIdentity>,
    pub core_archive: Stm32FileIdentity,
    pub core_archive_members: Vec<String>,
    pub dependency_files: Vec<Stm32ExternalFileIdentity>,
    pub tool_files: Vec<Stm32ExternalFileIdentity>,
    pub link_scripts: Vec<Stm32ExternalFileIdentity>,
    pub commands: Stm32CommandGraph,
    pub command_graph_sha256: String,
    pub mutable: Stm32MutableSeal,
}

#[derive(Debug, Clone)]
pub(crate) struct Stm32BaselineCapture<'a> {
    pub build_root: &'a Path,
    pub core_root: &'a Path,
    pub toolchain_root: &'a Path,
    pub ccdb_path: &'a Path,
    pub build_options_path: &'a Path,
    pub project_name: &'a str,
    pub sketch_ino_path: &'a Path,
    pub source: &'a str,
    pub access: Stm32AccessBinding,
    pub archive_members: Vec<String>,
    pub commands: Stm32CommandGraph,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Stm32CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

pub(crate) trait Stm32CommandExecutor {
    fn run(
        &mut self,
        command: &Stm32CommandSpec,
        cancelled: &AtomicBool,
    ) -> Result<Stm32CommandOutput, String>;
}

#[derive(Debug, Clone)]
pub(crate) struct Stm32RelinkRequest<'a> {
    pub manifest_path: &'a Path,
    pub build_root: &'a Path,
    pub source: &'a str,
    pub translation_proof: Stm32TranslationProof,
    pub authorization_key: &'a str,
    pub intent: Stm32CompileIntent,
    pub profile: &'a str,
    pub third_party_libraries: &'a [String],
    pub cancelled: Arc<AtomicBool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Stm32RelinkResult {
    pub manifest_sha256: String,
    pub artifact_sha256: BTreeMap<String, String>,
    pub stage_duration_ms: BTreeMap<String, u64>,
    pub size_stdout: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CcdbRecord {
    directory: PathBuf,
    arguments: Vec<String>,
    file: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirtyMarker {
    schema_version: u32,
    engine_contract: String,
    previous_manifest_sha256: String,
    stage: String,
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn constant_time_ascii_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut difference = left.len() ^ right.len();
    let length = left.len().max(right.len());
    for index in 0..length {
        let a = left.get(index).copied().unwrap_or_default();
        let b = right.get(index).copied().unwrap_or_default();
        difference |= usize::from(a ^ b);
    }
    difference == 0
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn read_bounded_regular(path: &Path, maximum: u64) -> GateResult<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        Stm32GateError::new(
            Stm32GateCode::MissingFile,
            format!("cannot inspect {}: {error}", path.display()),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(Stm32GateError::new(
            Stm32GateCode::UnsafeFilesystemEntry,
            format!("{} is not an ordinary file", path.display()),
        ));
    }
    if metadata.len() == 0 {
        return Err(Stm32GateError::new(
            Stm32GateCode::EmptyFile,
            format!("{} is empty", path.display()),
        ));
    }
    if metadata.len() > maximum {
        return Err(Stm32GateError::new(
            Stm32GateCode::FileTooLarge,
            format!("{} exceeds {maximum} bytes", path.display()),
        ));
    }
    fs::read(path).map_err(|error| {
        Stm32GateError::new(
            Stm32GateCode::MissingFile,
            format!("cannot read {}: {error}", path.display()),
        )
    })
}

fn canonical_directory(path: &Path) -> GateResult<PathBuf> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        Stm32GateError::new(
            Stm32GateCode::InvalidPath,
            format!("cannot inspect directory {}: {error}", path.display()),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(Stm32GateError::new(
            Stm32GateCode::UnsafeFilesystemEntry,
            format!("{} is not an ordinary directory", path.display()),
        ));
    }
    fs::canonicalize(path).map_err(|error| {
        Stm32GateError::new(
            Stm32GateCode::InvalidPath,
            format!("cannot canonicalize {}: {error}", path.display()),
        )
    })
}

fn canonical_regular(path: &Path) -> GateResult<PathBuf> {
    let _ = read_bounded_regular(path, MAX_IDENTITY_FILE_BYTES)?;
    fs::canonicalize(path).map_err(|error| {
        Stm32GateError::new(
            Stm32GateCode::InvalidPath,
            format!("cannot canonicalize {}: {error}", path.display()),
        )
    })
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn canonical_within(path: &Path, root: &Path) -> GateResult<PathBuf> {
    let canonical = canonical_regular(path)?;
    let root = canonical_directory(root)?;
    if canonical.strip_prefix(&root).is_err() {
        return Err(Stm32GateError::new(
            Stm32GateCode::InvalidPath,
            format!("{} escaped {}", canonical.display(), root.display()),
        ));
    }
    Ok(canonical)
}

fn relative_string(root: &Path, path: &Path) -> GateResult<String> {
    let relative = path.strip_prefix(root).map_err(|_| {
        Stm32GateError::new(
            Stm32GateCode::InvalidPath,
            format!("{} is outside {}", path.display(), root.display()),
        )
    })?;
    if relative.as_os_str().is_empty()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(Stm32GateError::new(
            Stm32GateCode::InvalidPath,
            "relative identity path is unsafe",
        ));
    }
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn identity_within(root: &Path, path: &Path) -> GateResult<Stm32FileIdentity> {
    let root = canonical_directory(root)?;
    let path = canonical_within(path, &root)?;
    let bytes = read_bounded_regular(&path, MAX_IDENTITY_FILE_BYTES)?;
    Ok(Stm32FileIdentity {
        relative_path: relative_string(&root, &path)?,
        size: bytes.len() as u64,
        sha256: sha256_bytes(&bytes),
    })
}

fn external_identity(path: &Path) -> GateResult<Stm32ExternalFileIdentity> {
    let path = canonical_regular(path)?;
    let bytes = read_bounded_regular(&path, MAX_IDENTITY_FILE_BYTES)?;
    Ok(Stm32ExternalFileIdentity {
        canonical_path: path.to_string_lossy().into_owned(),
        size: bytes.len() as u64,
        sha256: sha256_bytes(&bytes),
    })
}

fn resolve_relative_identity(root: &Path, identity: &Stm32FileIdentity) -> GateResult<PathBuf> {
    if !is_sha256_hex(&identity.sha256)
        || identity.size == 0
        || identity.relative_path.contains('\\')
    {
        return Err(Stm32GateError::new(
            Stm32GateCode::InvalidManifest,
            "relative file identity is malformed",
        ));
    }
    let relative = Path::new(&identity.relative_path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(Stm32GateError::new(
            Stm32GateCode::InvalidManifest,
            "relative file identity escaped the build root",
        ));
    }
    Ok(root.join(relative))
}

fn verify_relative_identity(root: &Path, identity: &Stm32FileIdentity) -> GateResult<PathBuf> {
    let path = resolve_relative_identity(root, identity)?;
    let observed = identity_within(root, &path)?;
    if observed != *identity {
        return Err(Stm32GateError::new(
            Stm32GateCode::ArtifactSealFailed,
            format!("identity changed for {}", identity.relative_path),
        ));
    }
    canonical_regular(&path)
}

fn verify_external_identity(identity: &Stm32ExternalFileIdentity) -> GateResult<PathBuf> {
    if !is_sha256_hex(&identity.sha256) || identity.size == 0 {
        return Err(Stm32GateError::new(
            Stm32GateCode::InvalidManifest,
            "external file identity is malformed",
        ));
    }
    let observed = external_identity(Path::new(&identity.canonical_path))?;
    if observed != *identity {
        return Err(Stm32GateError::new(
            Stm32GateCode::ArtifactSealFailed,
            format!("identity changed for {}", identity.canonical_path),
        ));
    }
    canonical_regular(Path::new(&identity.canonical_path))
}

fn resolve_command_path(directory: &Path, token: &str) -> PathBuf {
    let path = Path::new(token);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        directory.join(path)
    }
}

fn resolve_executable_path(directory: &Path, token: &str) -> PathBuf {
    let candidate = resolve_command_path(directory, token);
    if candidate.exists() || !cfg!(windows) {
        return candidate;
    }
    let mut executable = candidate.as_os_str().to_os_string();
    executable.push(".exe");
    PathBuf::from(executable)
}

fn command_output(command: &Stm32CommandSpec) -> GateResult<PathBuf> {
    let positions = command
        .argv
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (token == "-o").then_some(index))
        .collect::<Vec<_>>();
    if positions.len() == 1 && positions[0] + 1 < command.argv.len() {
        return Ok(resolve_command_path(
            &command.working_directory,
            &command.argv[positions[0] + 1],
        ));
    }
    // STM32 Core 2.12.0 uses GNU objcopy's positional
    // `<input-elf> <output-bin-or-hex>` form.  This is deliberately limited to
    // objcopy roles; accepting a generic final token would weaken link/compile
    // output validation.
    if positions.is_empty()
        && matches!(
            command.role,
            Stm32CommandRole::ObjcopyBin | Stm32CommandRole::ObjcopyHex
        )
        && command.argv.len() >= 4
    {
        return Ok(resolve_command_path(
            &command.working_directory,
            command.argv.last().expect("length checked"),
        ));
    }
    {
        return Err(Stm32GateError::new(
            Stm32GateCode::CommandGraphMismatch,
            format!("{:?} has no canonical output token", command.role),
        ));
    }
}

fn ccdb_output(record: &CcdbRecord) -> GateResult<PathBuf> {
    let command = Stm32CommandSpec {
        role: Stm32CommandRole::CompileSketch,
        working_directory: record.directory.clone(),
        argv: record.arguments.clone(),
    };
    command_output(&command)
}

fn load_ccdb(path: &Path) -> GateResult<Vec<CcdbRecord>> {
    let bytes = read_bounded_regular(path, MAX_IDENTITY_FILE_BYTES)?;
    serde_json::from_slice(&bytes).map_err(|error| {
        Stm32GateError::new(
            Stm32GateCode::CcdbMismatch,
            format!("cannot parse CCDB: {error}"),
        )
    })
}

fn extract_link_objects(
    command: &Stm32CommandSpec,
    core_archive: &Path,
) -> GateResult<Vec<PathBuf>> {
    if command.role != Stm32CommandRole::Link {
        return Err(Stm32GateError::new(
            Stm32GateCode::CommandGraphMismatch,
            "link command role is wrong",
        ));
    }
    let start = command
        .argv
        .iter()
        .position(|token| token == "-Wl,--start-group")
        .ok_or_else(|| {
            Stm32GateError::new(
                Stm32GateCode::CommandGraphMismatch,
                "link command lacks --start-group",
            )
        })?;
    let archive_key = path_key(&canonical_regular(core_archive)?);
    let archive = command
        .argv
        .iter()
        .enumerate()
        .skip(start + 1)
        .find_map(|(index, token)| {
            let candidate = resolve_command_path(&command.working_directory, token);
            canonical_regular(&candidate)
                .ok()
                .filter(|path| path_key(path) == archive_key)
                .map(|_| index)
        })
        .ok_or_else(|| {
            Stm32GateError::new(
                Stm32GateCode::CommandGraphMismatch,
                "link command does not contain the sealed core archive",
            )
        })?;
    if archive <= start + 1 {
        return Err(Stm32GateError::new(
            Stm32GateCode::CommandGraphMismatch,
            "link object segment is empty",
        ));
    }
    command.argv[start + 1..archive]
        .iter()
        .map(|token| canonical_regular(&resolve_command_path(&command.working_directory, token)))
        .collect()
}

fn link_script_paths(command: &Stm32CommandSpec) -> GateResult<Vec<PathBuf>> {
    let prefixes = ["-Wl,--default-script=", "-Wl,--script="];
    let mut paths = Vec::new();
    for prefix in prefixes {
        let matches = command
            .argv
            .iter()
            .filter_map(|token| token.strip_prefix(prefix))
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(Stm32GateError::new(
                Stm32GateCode::CommandGraphMismatch,
                format!("link command requires exactly one {prefix} token"),
            ));
        }
        paths.push(resolve_command_path(&command.working_directory, matches[0]));
    }
    Ok(paths)
}

fn response_file_paths(command: &Stm32CommandSpec) -> Vec<PathBuf> {
    command
        .argv
        .iter()
        .filter_map(|token| token.strip_prefix('@'))
        .map(|token| resolve_command_path(&command.working_directory, token))
        .collect()
}

fn parse_depfile(path: &Path, expected_object: &Path) -> GateResult<Vec<PathBuf>> {
    let bytes = read_bounded_regular(path, MAX_DEPFILE_BYTES)?;
    let text = String::from_utf8(bytes).map_err(|error| {
        Stm32GateError::new(
            Stm32GateCode::DependencyMismatch,
            format!("depfile is not UTF-8: {error}"),
        )
    })?;
    let collapsed = text.replace("\\\r\n", " ").replace("\\\n", " ");
    let delimiter = collapsed.find(": ").ok_or_else(|| {
        Stm32GateError::new(
            Stm32GateCode::DependencyMismatch,
            "depfile has no single target delimiter",
        )
    })?;
    let target = Path::new(collapsed[..delimiter].trim());
    if path_key(&canonical_regular(target)?) != path_key(&canonical_regular(expected_object)?) {
        return Err(Stm32GateError::new(
            Stm32GateCode::DependencyMismatch,
            "depfile target is not the sketch object",
        ));
    }
    let dependencies = collapsed[delimiter + 2..]
        .split_whitespace()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    if dependencies.is_empty() {
        return Err(Stm32GateError::new(
            Stm32GateCode::DependencyMismatch,
            "depfile has no prerequisites",
        ));
    }
    let mut seen = BTreeSet::new();
    let mut canonical = Vec::with_capacity(dependencies.len());
    for dependency in dependencies {
        let path = canonical_regular(&dependency)?;
        if !seen.insert(path_key(&path)) {
            // GCC may repeat an include reached through multiple wrapper
            // headers.  Dependency identity is a set; accepting the duplicate
            // does not broaden the closure, while rejecting it would make the
            // real STM32 Core 2.12.0 graph unusable.
            continue;
        }
        canonical.push(path);
    }
    Ok(canonical)
}

fn render_direct_cpp(source: &str, sketch_ino: &Path) -> GateResult<String> {
    let value = sketch_ino.to_str().ok_or_else(|| {
        Stm32GateError::new(
            Stm32GateCode::TranslationUnsupported,
            "sketch path is not UTF-8",
        )
    })?;
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    Ok(format!("#line 1 \"{escaped}\"\n{source}"))
}

fn validate_project_name(name: &str) -> GateResult<()> {
    if name.is_empty()
        || name.len() > MAX_PROJECT_NAME_BYTES
        || name.contains(['/', '\\'])
        || name == "."
        || name == ".."
    {
        return Err(Stm32GateError::new(
            Stm32GateCode::InvalidManifest,
            "project name is unsafe",
        ));
    }
    Ok(())
}

fn validate_command_tools(
    commands: &Stm32CommandGraph,
    toolchain_root: &Path,
) -> GateResult<Vec<Stm32ExternalFileIdentity>> {
    let root = canonical_directory(toolchain_root)?;
    let expected_roles = [
        Stm32CommandRole::CompileSketch,
        Stm32CommandRole::Link,
        Stm32CommandRole::ObjcopyBin,
        Stm32CommandRole::ObjcopyHex,
        Stm32CommandRole::Size,
    ];
    let mut identities = BTreeMap::<String, Stm32ExternalFileIdentity>::new();
    for (command, expected_role) in commands.ordered().into_iter().zip(expected_roles) {
        if command.role != expected_role || command.argv.is_empty() {
            return Err(Stm32GateError::new(
                Stm32GateCode::CommandGraphMismatch,
                "command order/role is not canonical",
            ));
        }
        let tool = canonical_within(
            &resolve_executable_path(&command.working_directory, &command.argv[0]),
            &root,
        )
        .map_err(|error| {
            Stm32GateError::new(
                Stm32GateCode::ToolOutsideManagedRoot,
                format!("tool rejected: {error}"),
            )
        })?;
        identities.insert(path_key(&tool), external_identity(&tool)?);
    }
    Ok(identities.into_values().collect())
}

fn output_identity_for(
    build_root: &Path,
    command: &Stm32CommandSpec,
) -> GateResult<Stm32FileIdentity> {
    identity_within(build_root, &command_output(command)?)
}

fn artifact_path(build_root: &Path, project_name: &str, extension: &str) -> PathBuf {
    build_root.join(format!("{project_name}.{extension}"))
}

fn same_path(left: &Path, right: &Path) -> GateResult<bool> {
    Ok(path_key(&canonical_regular(left)?) == path_key(&canonical_regular(right)?))
}

pub(crate) fn capture_stm32_native_relink_baseline(
    input: Stm32BaselineCapture<'_>,
) -> GateResult<Stm32NativeRelinkManifest> {
    input.access.validate()?;
    validate_project_name(input.project_name)?;
    if input.access.canonical_fqbn != STM32_PHASE1_FQBN
        || input.access.core_version != STM32_PHASE1_CORE_VERSION
    {
        return Err(Stm32GateError::new(
            Stm32GateCode::UnsupportedCapabilityGraph,
            "Phase 1 is bound to the NUCLEO_F401RE Core 2.12.0 sample",
        ));
    }
    let build_root = canonical_directory(input.build_root)?;
    let core_root = canonical_directory(input.core_root)?;
    let toolchain_root = canonical_directory(input.toolchain_root)?;
    let sketch_ino = canonical_regular(input.sketch_ino_path)?;
    let ccdb_records = load_ccdb(input.ccdb_path)?;
    if ccdb_records.len() != EXPECTED_CCDB_ENTRIES {
        return Err(Stm32GateError::new(
            Stm32GateCode::UnsupportedCapabilityGraph,
            format!(
                "Phase 1 requires {EXPECTED_CCDB_ENTRIES} CCDB entries, observed {}",
                ccdb_records.len()
            ),
        ));
    }
    let mut category_counts = BTreeMap::<String, usize>::new();
    let mut outputs = BTreeMap::<String, PathBuf>::new();
    let mut sketch_record = None;
    for record in &ccdb_records {
        if record.arguments.is_empty() {
            return Err(Stm32GateError::new(
                Stm32GateCode::CcdbMismatch,
                "CCDB entry has no argument vector",
            ));
        }
        let source = canonical_regular(&record.file)?;
        let source_allowed =
            source.strip_prefix(&build_root).is_ok() || source.strip_prefix(&core_root).is_ok();
        if !source_allowed {
            return Err(Stm32GateError::new(
                Stm32GateCode::ThirdPartyLibrariesDenied,
                format!(
                    "CCDB source escaped managed Core/build roots: {}",
                    source.display()
                ),
            ));
        }
        let output = canonical_within(&ccdb_output(record)?, &build_root)?;
        let relative = relative_string(&build_root, &output)?;
        let category = relative.split('/').next().unwrap_or_default().to_string();
        *category_counts.entry(category).or_default() += 1;
        if outputs.insert(path_key(&output), output.clone()).is_some() {
            return Err(Stm32GateError::new(
                Stm32GateCode::CcdbMismatch,
                "CCDB contains duplicate outputs",
            ));
        }
        if record.file.to_string_lossy().ends_with(".ino.cpp") {
            if sketch_record.replace(record).is_some() {
                return Err(Stm32GateError::new(
                    Stm32GateCode::CcdbMismatch,
                    "CCDB has multiple sketch .ino.cpp records",
                ));
            }
        }
    }
    let expected_counts = [
        ("sketch", EXPECTED_SKETCH_CCDB_ENTRIES),
        ("libraries", EXPECTED_LIBRARY_CCDB_ENTRIES),
        ("core", EXPECTED_CORE_CCDB_ENTRIES),
    ];
    if category_counts.len() != expected_counts.len()
        || expected_counts
            .iter()
            .any(|(name, expected)| category_counts.get(*name) != Some(expected))
    {
        return Err(Stm32GateError::new(
            Stm32GateCode::UnsupportedCapabilityGraph,
            format!("CCDB category shape changed: {category_counts:?}"),
        ));
    }
    let sketch_record = sketch_record.ok_or_else(|| {
        Stm32GateError::new(
            Stm32GateCode::CcdbMismatch,
            "CCDB has no sketch .ino.cpp record",
        )
    })?;
    if sketch_record.arguments != input.commands.compile_sketch.argv
        || path_key(&canonical_directory(&sketch_record.directory)?)
            != path_key(&canonical_directory(
                &input.commands.compile_sketch.working_directory,
            )?)
    {
        return Err(Stm32GateError::new(
            Stm32GateCode::CommandGraphMismatch,
            "compile command is not the exact CCDB argument vector",
        ));
    }
    let generated_cpp = canonical_within(&sketch_record.file, &build_root)?;
    let sketch_object = canonical_within(&ccdb_output(sketch_record)?, &build_root)?;
    let depfile = sketch_object.with_extension("d");
    let core_archive_path = build_root.join("core/core.a");
    let ordered_paths = extract_link_objects(&input.commands.link, &core_archive_path)?;
    if ordered_paths.len() != EXPECTED_ORDERED_OBJECTS {
        return Err(Stm32GateError::new(
            Stm32GateCode::UnsupportedCapabilityGraph,
            format!(
                "expected {EXPECTED_ORDERED_OBJECTS} ordered link objects, got {}",
                ordered_paths.len()
            ),
        ));
    }
    if !same_path(&ordered_paths[0], &sketch_object)? {
        return Err(Stm32GateError::new(
            Stm32GateCode::UnsupportedCapabilityGraph,
            "sketch object is not the first ordered link object",
        ));
    }
    let ordered_keys = ordered_paths
        .iter()
        .map(|path| path_key(path))
        .collect::<BTreeSet<_>>();
    if ordered_keys.len() != EXPECTED_ORDERED_OBJECTS
        || ordered_keys.iter().any(|key| !outputs.contains_key(key))
    {
        return Err(Stm32GateError::new(
            Stm32GateCode::UnsupportedCapabilityGraph,
            "ordered link objects are not a unique CCDB subset",
        ));
    }
    let archived_paths = outputs
        .iter()
        .filter_map(|(key, path)| (!ordered_keys.contains(key)).then_some(path.clone()))
        .collect::<Vec<_>>();
    if archived_paths.len() != EXPECTED_ARCHIVE_MEMBERS
        || archived_paths.iter().any(|path| {
            relative_string(&build_root, path)
                .map(|relative| !relative.starts_with("core/"))
                .unwrap_or(true)
        })
    {
        return Err(Stm32GateError::new(
            Stm32GateCode::UnsupportedCapabilityGraph,
            "the 24 archived CCDB objects are not the expected core-only complement",
        ));
    }
    let mut expected_members = archived_paths
        .iter()
        .map(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .ok_or_else(|| {
                    Stm32GateError::new(
                        Stm32GateCode::UnsupportedCapabilityGraph,
                        "archived object has no file name",
                    )
                })
        })
        .collect::<GateResult<Vec<_>>>()?;
    expected_members.sort();
    let mut observed_members = input.archive_members.clone();
    observed_members.sort();
    if observed_members.len() != EXPECTED_ARCHIVE_MEMBERS || observed_members != expected_members {
        return Err(Stm32GateError::new(
            Stm32GateCode::UnsupportedCapabilityGraph,
            "core.a members do not match the 24 archived CCDB objects",
        ));
    }
    let response_paths = response_file_paths(&input.commands.compile_sketch);
    let build_opt_path = build_root.join("sketch/build.opt");
    if response_paths.len() != 1 || !same_path(&response_paths[0], &build_opt_path)? {
        return Err(Stm32GateError::new(
            Stm32GateCode::CommandGraphMismatch,
            "sketch compile must bind exactly sketch/build.opt",
        ));
    }
    if input
        .commands
        .ordered()
        .iter()
        .skip(1)
        .any(|command| !response_file_paths(command).is_empty())
    {
        return Err(Stm32GateError::new(
            Stm32GateCode::CommandGraphMismatch,
            "Phase 1 does not permit unsealed response files outside sketch compile",
        ));
    }
    let link_scripts = link_script_paths(&input.commands.link)?
        .into_iter()
        .map(|path| {
            let canonical = canonical_within(&path, &core_root)?;
            external_identity(&canonical)
        })
        .collect::<GateResult<Vec<_>>>()?;
    let tool_files = validate_command_tools(&input.commands, &toolchain_root)?;
    let link_output = command_output(&input.commands.link)?;
    let bin_output = command_output(&input.commands.objcopy_bin)?;
    let hex_output = command_output(&input.commands.objcopy_hex)?;
    for (observed, expected) in [
        (
            link_output,
            artifact_path(&build_root, input.project_name, "elf"),
        ),
        (
            bin_output,
            artifact_path(&build_root, input.project_name, "bin"),
        ),
        (
            hex_output,
            artifact_path(&build_root, input.project_name, "hex"),
        ),
    ] {
        if !same_path(&observed, &expected)? {
            return Err(Stm32GateError::new(
                Stm32GateCode::CommandGraphMismatch,
                "artifact command output does not match the project name",
            ));
        }
    }
    let dependencies = parse_depfile(&depfile, &sketch_object)?;
    if !same_path(&dependencies[0], &generated_cpp)? {
        return Err(Stm32GateError::new(
            Stm32GateCode::DependencyMismatch,
            "generated .ino.cpp is not the first dependency",
        ));
    }
    let dependency_files = dependencies
        .iter()
        .skip(1)
        .map(|path| external_identity(path))
        .collect::<GateResult<Vec<_>>>()?;
    let ordered_link_objects = ordered_paths
        .iter()
        .map(|path| identity_within(&build_root, path))
        .collect::<GateResult<Vec<_>>>()?;
    let immutable_link_objects = ordered_paths
        .iter()
        .skip(1)
        .map(|path| identity_within(&build_root, path))
        .collect::<GateResult<Vec<_>>>()?;
    if immutable_link_objects.len() != EXPECTED_IMMUTABLE_OBJECTS {
        return Err(Stm32GateError::new(
            Stm32GateCode::UnsupportedCapabilityGraph,
            "immutable ordered object count changed",
        ));
    }
    let archived_ccdb_objects = archived_paths
        .iter()
        .map(|path| identity_within(&build_root, path))
        .collect::<GateResult<Vec<_>>>()?;
    let mutable = Stm32MutableSeal {
        generated_cpp: identity_within(&build_root, &generated_cpp)?,
        sketch_object: identity_within(&build_root, &sketch_object)?,
        sketch_depfile: identity_within(&build_root, &depfile)?,
        map: identity_within(
            &build_root,
            &artifact_path(&build_root, input.project_name, "map"),
        )?,
        elf: output_identity_for(&build_root, &input.commands.link)?,
        bin: output_identity_for(&build_root, &input.commands.objcopy_bin)?,
        hex: output_identity_for(&build_root, &input.commands.objcopy_hex)?,
    };
    Ok(Stm32NativeRelinkManifest {
        schema_version: STM32_NATIVE_RELINK_SCHEMA_VERSION,
        engine_contract: STM32_NATIVE_RELINK_ENGINE_CONTRACT.to_string(),
        capability_class: STM32_NATIVE_RELINK_CAPABILITY_CLASS.to_string(),
        access: input.access,
        project_name: input.project_name.to_string(),
        sketch_ino_path: sketch_ino.to_string_lossy().into_owned(),
        source_sha256: sha256_bytes(input.source.as_bytes()),
        build_root: build_root.to_string_lossy().into_owned(),
        core_root: core_root.to_string_lossy().into_owned(),
        toolchain_root: toolchain_root.to_string_lossy().into_owned(),
        ccdb: identity_within(&build_root, input.ccdb_path)?,
        build_options: identity_within(&build_root, input.build_options_path)?,
        build_opt: identity_within(&build_root, &build_opt_path)?,
        ordered_link_objects,
        immutable_link_objects,
        archived_ccdb_objects,
        core_archive: identity_within(&build_root, &core_archive_path)?,
        core_archive_members: input.archive_members,
        dependency_files,
        tool_files,
        link_scripts,
        command_graph_sha256: input.commands.sha256()?,
        commands: input.commands,
        mutable,
    })
}

fn manifest_bytes(manifest: &Stm32NativeRelinkManifest) -> GateResult<Vec<u8>> {
    serde_json::to_vec_pretty(manifest).map_err(|error| {
        Stm32GateError::new(
            Stm32GateCode::InvalidManifest,
            format!("cannot serialize manifest: {error}"),
        )
    })
}

fn atomic_write(path: &Path, bytes: &[u8]) -> GateResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Stm32GateError::new(Stm32GateCode::InvalidPath, "output has no parent"))?;
    fs::create_dir_all(parent).map_err(|error| {
        Stm32GateError::new(
            Stm32GateCode::InvalidPath,
            format!("cannot create {}: {error}", parent.display()),
        )
    })?;
    let nonce = TEMP_NONCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{}.ck-stm32-{nonce}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| {
            Stm32GateError::new(
                Stm32GateCode::InvalidPath,
                format!("cannot create {}: {error}", temporary.display()),
            )
        })?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| {
            Stm32GateError::new(
                Stm32GateCode::InvalidPath,
                format!("cannot write {}: {error}", temporary.display()),
            )
        })?;
    drop(file);
    if let Err(error) = fs::rename(&temporary, path) {
        if path.exists() {
            fs::remove_file(path).map_err(|remove_error| {
                Stm32GateError::new(
                    Stm32GateCode::InvalidPath,
                    format!("cannot replace {}: {error}; {remove_error}", path.display()),
                )
            })?;
            fs::rename(&temporary, path).map_err(|rename_error| {
                Stm32GateError::new(
                    Stm32GateCode::InvalidPath,
                    format!("cannot install {}: {rename_error}", path.display()),
                )
            })?;
        } else {
            return Err(Stm32GateError::new(
                Stm32GateCode::InvalidPath,
                format!("cannot install {}: {error}", path.display()),
            ));
        }
    }
    Ok(())
}

pub(crate) fn write_stm32_native_relink_manifest(
    path: &Path,
    manifest: &Stm32NativeRelinkManifest,
) -> GateResult<String> {
    let bytes = manifest_bytes(manifest)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(Stm32GateError::new(
            Stm32GateCode::FileTooLarge,
            "STM32 manifest exceeds its size limit",
        ));
    }
    atomic_write(path, &bytes)?;
    Ok(sha256_bytes(&bytes))
}

fn load_manifest(path: &Path) -> GateResult<(Stm32NativeRelinkManifest, String)> {
    let bytes = read_bounded_regular(path, MAX_MANIFEST_BYTES)?;
    let sha = sha256_bytes(&bytes);
    let manifest = serde_json::from_slice(&bytes).map_err(|error| {
        Stm32GateError::new(
            Stm32GateCode::InvalidManifest,
            format!("cannot parse STM32 manifest: {error}"),
        )
    })?;
    Ok((manifest, sha))
}

fn validate_manifest_header(
    manifest: &Stm32NativeRelinkManifest,
    build_root: &Path,
) -> GateResult<()> {
    manifest.access.validate()?;
    validate_project_name(&manifest.project_name)?;
    if manifest.schema_version != STM32_NATIVE_RELINK_SCHEMA_VERSION
        || manifest.engine_contract != STM32_NATIVE_RELINK_ENGINE_CONTRACT
        || manifest.capability_class != STM32_NATIVE_RELINK_CAPABILITY_CLASS
        || manifest.access.canonical_fqbn != STM32_PHASE1_FQBN
        || manifest.access.core_version != STM32_PHASE1_CORE_VERSION
        || !is_sha256_hex(&manifest.source_sha256)
        || manifest.command_graph_sha256 != manifest.commands.sha256()?
    {
        return Err(Stm32GateError::new(
            Stm32GateCode::InvalidManifest,
            "STM32 manifest header/graph identity is invalid",
        ));
    }
    let actual_root = canonical_directory(build_root)?;
    let sealed_root = canonical_directory(Path::new(&manifest.build_root))?;
    if path_key(&actual_root) != path_key(&sealed_root) {
        return Err(Stm32GateError::new(
            Stm32GateCode::InvalidManifest,
            "request build root differs from the sealed root",
        ));
    }
    if manifest.ordered_link_objects.len() != EXPECTED_ORDERED_OBJECTS
        || manifest.immutable_link_objects.len() != EXPECTED_IMMUTABLE_OBJECTS
        || manifest.archived_ccdb_objects.len() != EXPECTED_ARCHIVE_MEMBERS
        || manifest.core_archive_members.len() != EXPECTED_ARCHIVE_MEMBERS
    {
        return Err(Stm32GateError::new(
            Stm32GateCode::UnsupportedCapabilityGraph,
            "manifest object/archive cardinality changed",
        ));
    }
    Ok(())
}

fn verify_fixed_seal(manifest: &Stm32NativeRelinkManifest, build_root: &Path) -> GateResult<()> {
    verify_relative_identity(build_root, &manifest.ccdb)?;
    verify_relative_identity(build_root, &manifest.build_options)?;
    verify_relative_identity(build_root, &manifest.build_opt)?;
    for identity in &manifest.immutable_link_objects {
        verify_relative_identity(build_root, identity)?;
    }
    for identity in &manifest.archived_ccdb_objects {
        verify_relative_identity(build_root, identity)?;
    }
    verify_relative_identity(build_root, &manifest.core_archive)?;
    for identity in &manifest.dependency_files {
        verify_external_identity(identity)?;
    }
    let toolchain_root = canonical_directory(Path::new(&manifest.toolchain_root))?;
    for identity in &manifest.tool_files {
        let path = verify_external_identity(identity)?;
        if path.strip_prefix(&toolchain_root).is_err() {
            return Err(Stm32GateError::new(
                Stm32GateCode::ToolOutsideManagedRoot,
                "sealed tool escaped the managed toolchain",
            ));
        }
    }
    let core_root = canonical_directory(Path::new(&manifest.core_root))?;
    for identity in &manifest.link_scripts {
        let path = verify_external_identity(identity)?;
        if path.strip_prefix(&core_root).is_err() {
            return Err(Stm32GateError::new(
                Stm32GateCode::InvalidPath,
                "sealed linker script escaped the Core",
            ));
        }
    }
    let core_archive = resolve_relative_identity(build_root, &manifest.core_archive)?;
    let link_objects = extract_link_objects(&manifest.commands.link, &core_archive)?;
    let observed = link_objects
        .iter()
        .map(|path| identity_within(build_root, path))
        .collect::<GateResult<Vec<_>>>()?;
    if observed.len() != EXPECTED_ORDERED_OBJECTS
        || observed[0].relative_path != manifest.mutable.sketch_object.relative_path
        || observed[1..] != manifest.immutable_link_objects
        || manifest.ordered_link_objects[1..] != manifest.immutable_link_objects
    {
        return Err(Stm32GateError::new(
            Stm32GateCode::CommandGraphMismatch,
            "ordered link-object vector changed",
        ));
    }
    Ok(())
}

fn verify_mutable_seal(manifest: &Stm32NativeRelinkManifest, build_root: &Path) -> GateResult<()> {
    for identity in [
        &manifest.mutable.generated_cpp,
        &manifest.mutable.sketch_object,
        &manifest.mutable.sketch_depfile,
        &manifest.mutable.map,
        &manifest.mutable.elf,
        &manifest.mutable.bin,
        &manifest.mutable.hex,
    ] {
        verify_relative_identity(build_root, identity)?;
    }
    Ok(())
}

fn ensure_no_upload_artifacts(build_root: &Path) -> GateResult<()> {
    if build_root.join(".ck-upload-artifacts.json").exists() {
        return Err(Stm32GateError::new(
            Stm32GateCode::ArtifactSealFailed,
            "compile-only transaction found an upload manifest",
        ));
    }
    for entry in fs::read_dir(build_root).map_err(|error| {
        Stm32GateError::new(
            Stm32GateCode::InvalidPath,
            format!("cannot inspect build root: {error}"),
        )
    })? {
        let entry = entry
            .map_err(|error| Stm32GateError::new(Stm32GateCode::InvalidPath, error.to_string()))?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.contains(".with_bootloader.") {
            return Err(Stm32GateError::new(
                Stm32GateCode::ArtifactSealFailed,
                "compile-only transaction found a with_bootloader artifact",
            ));
        }
    }
    Ok(())
}

fn dirty_marker_path(manifest_path: &Path) -> PathBuf {
    let mut value = manifest_path.as_os_str().to_os_string();
    value.push(".dirty");
    PathBuf::from(value)
}

fn transaction_dir(build_root: &Path) -> PathBuf {
    build_root.join(".ck-stm32-native-relink-transaction")
}

fn backup_mutable_files(
    manifest: &Stm32NativeRelinkManifest,
    build_root: &Path,
    backup_root: &Path,
) -> GateResult<Vec<(PathBuf, PathBuf)>> {
    if backup_root.exists() {
        return Err(Stm32GateError::new(
            Stm32GateCode::DirtyBuild,
            "a previous STM32 transaction directory still exists",
        ));
    }
    fs::create_dir(backup_root).map_err(|error| {
        Stm32GateError::new(
            Stm32GateCode::DirtyBuild,
            format!("cannot create transaction directory: {error}"),
        )
    })?;
    let identities = [
        &manifest.mutable.generated_cpp,
        &manifest.mutable.sketch_object,
        &manifest.mutable.sketch_depfile,
        &manifest.mutable.map,
        &manifest.mutable.elf,
        &manifest.mutable.bin,
        &manifest.mutable.hex,
    ];
    let mut backups = Vec::new();
    for (index, identity) in identities.into_iter().enumerate() {
        let original = resolve_relative_identity(build_root, identity)?;
        let backup = backup_root.join(format!("{index}.backup"));
        fs::copy(&original, &backup).map_err(|error| {
            Stm32GateError::new(
                Stm32GateCode::DirtyBuild,
                format!("cannot back up {}: {error}", original.display()),
            )
        })?;
        backups.push((original, backup));
    }
    Ok(backups)
}

fn restore_backups(backups: &[(PathBuf, PathBuf)]) -> GateResult<()> {
    for (original, backup) in backups {
        fs::copy(backup, original).map_err(|error| {
            Stm32GateError::new(
                Stm32GateCode::DirtyBuild,
                format!("cannot restore {}: {error}", original.display()),
            )
        })?;
    }
    Ok(())
}

fn cleanup_transaction(backup_root: &Path, dirty: &Path) -> GateResult<()> {
    if backup_root.exists() {
        fs::remove_dir_all(backup_root).map_err(|error| {
            Stm32GateError::new(
                Stm32GateCode::DirtyBuild,
                format!("cannot remove transaction directory: {error}"),
            )
        })?;
    }
    if dirty.exists() {
        fs::remove_file(dirty).map_err(|error| {
            Stm32GateError::new(
                Stm32GateCode::DirtyBuild,
                format!("cannot remove dirty marker: {error}"),
            )
        })?;
    }
    Ok(())
}

fn write_dirty_marker(path: &Path, marker: &DirtyMarker) -> GateResult<()> {
    let bytes = serde_json::to_vec_pretty(marker)
        .map_err(|error| Stm32GateError::new(Stm32GateCode::DirtyBuild, error.to_string()))?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| {
            Stm32GateError::new(
                Stm32GateCode::DirtyBuild,
                format!("cannot create dirty marker: {error}"),
            )
        })?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| {
            Stm32GateError::new(
                Stm32GateCode::DirtyBuild,
                format!("cannot persist dirty marker: {error}"),
            )
        })
}

fn update_dirty_marker(path: &Path, marker: &mut DirtyMarker, stage: &str) -> GateResult<()> {
    marker.stage = stage.to_string();
    let bytes = serde_json::to_vec_pretty(marker)
        .map_err(|error| Stm32GateError::new(Stm32GateCode::DirtyBuild, error.to_string()))?;
    atomic_write(path, &bytes)
}

fn validate_request_before_tools(request: &Stm32RelinkRequest<'_>) -> GateResult<()> {
    if request.intent != Stm32CompileIntent::CompileOnly {
        return Err(Stm32GateError::new(
            Stm32GateCode::IntentDenied,
            "STM32 NativeRelink Phase 1 is compile-only",
        ));
    }
    if request.profile != "release" {
        return Err(Stm32GateError::new(
            Stm32GateCode::ProfileDenied,
            "STM32 NativeRelink Phase 1 requires Release",
        ));
    }
    if !request.third_party_libraries.is_empty() {
        return Err(Stm32GateError::new(
            Stm32GateCode::ThirdPartyLibrariesDenied,
            "STM32 NativeRelink Phase 1 does not accept third-party libraries",
        ));
    }
    if !is_sha256_hex(request.authorization_key) {
        return Err(Stm32GateError::new(
            Stm32GateCode::InvalidAccessKey,
            "authorization key is not a lowercase SHA-256 value",
        ));
    }
    if request.cancelled.load(Ordering::Acquire) {
        return Err(Stm32GateError::new(
            Stm32GateCode::Cancelled,
            "request was cancelled before validation",
        ));
    }
    request.translation_proof.validate(request.source)
}

fn rollback_failure(
    backups: &[(PathBuf, PathBuf)],
    backup_root: &Path,
    dirty: &Path,
    original: Stm32GateError,
) -> Stm32GateError {
    match restore_backups(backups).and_then(|_| cleanup_transaction(backup_root, dirty)) {
        Ok(()) => original,
        Err(rollback) => Stm32GateError::new(
            Stm32GateCode::DirtyBuild,
            format!("{original}; rollback failed: {rollback}"),
        ),
    }
}

pub(crate) fn execute_stm32_native_relink<E: Stm32CommandExecutor>(
    request: Stm32RelinkRequest<'_>,
    executor: &mut E,
) -> GateResult<Stm32RelinkResult> {
    // All operation/profile/library/access/translation gates are intentionally
    // before manifest I/O and, critically, before the first executor call.
    validate_request_before_tools(&request)?;
    let (mut manifest, previous_manifest_sha) = load_manifest(request.manifest_path)?;
    validate_manifest_header(&manifest, request.build_root)?;
    if !constant_time_ascii_eq(
        request.authorization_key,
        &manifest.access.authorization_key,
    ) {
        return Err(Stm32GateError::new(
            Stm32GateCode::InvalidAccessKey,
            "request authorization does not match the sealed access binding",
        ));
    }
    verify_fixed_seal(&manifest, request.build_root)?;
    verify_mutable_seal(&manifest, request.build_root)?;
    ensure_no_upload_artifacts(request.build_root)?;
    let dirty = dirty_marker_path(request.manifest_path);
    let backup_root = transaction_dir(request.build_root);
    if dirty.exists() || backup_root.exists() {
        return Err(Stm32GateError::new(
            Stm32GateCode::DirtyBuild,
            "retained dirty state requires one clean Arduino CLI rebuild",
        ));
    }
    let backups = backup_mutable_files(&manifest, request.build_root, &backup_root)?;
    let mut marker = DirtyMarker {
        schema_version: STM32_NATIVE_RELINK_SCHEMA_VERSION,
        engine_contract: STM32_NATIVE_RELINK_ENGINE_CONTRACT.to_string(),
        previous_manifest_sha256: previous_manifest_sha,
        stage: "prepared".to_string(),
    };
    if let Err(error) = write_dirty_marker(&dirty, &marker) {
        return Err(rollback_failure(&backups, &backup_root, &dirty, error));
    }
    let generated_cpp_path =
        match resolve_relative_identity(request.build_root, &manifest.mutable.generated_cpp) {
            Ok(path) => path,
            Err(error) => {
                return Err(rollback_failure(&backups, &backup_root, &dirty, error));
            }
        };
    let sketch_ino = Path::new(&manifest.sketch_ino_path);
    let rendered = match render_direct_cpp(request.source, sketch_ino) {
        Ok(value) => value,
        Err(error) => {
            return Err(rollback_failure(&backups, &backup_root, &dirty, error));
        }
    };
    if let Err(error) = atomic_write(&generated_cpp_path, rendered.as_bytes()) {
        return Err(rollback_failure(&backups, &backup_root, &dirty, error));
    }
    let mut stage_duration_ms = BTreeMap::new();
    let mut size_stdout = String::new();
    for command in manifest.commands.ordered() {
        if request.cancelled.load(Ordering::Acquire) {
            return Err(rollback_failure(
                &backups,
                &backup_root,
                &dirty,
                Stm32GateError::new(Stm32GateCode::Cancelled, "transaction cancelled"),
            ));
        }
        let stage = match command.role {
            Stm32CommandRole::CompileSketch => "compile-sketch",
            Stm32CommandRole::Link => "link",
            Stm32CommandRole::ObjcopyBin => "objcopy-bin",
            Stm32CommandRole::ObjcopyHex => "objcopy-hex",
            Stm32CommandRole::Size => "size",
        };
        if let Err(error) = update_dirty_marker(&dirty, &mut marker, stage) {
            return Err(rollback_failure(&backups, &backup_root, &dirty, error));
        }
        let output = match executor.run(command, &request.cancelled) {
            Ok(output) => output,
            Err(detail) => {
                let code = if request.cancelled.load(Ordering::Acquire) {
                    Stm32GateCode::Cancelled
                } else {
                    Stm32GateCode::ExecutionFailed
                };
                return Err(rollback_failure(
                    &backups,
                    &backup_root,
                    &dirty,
                    Stm32GateError::new(code, format!("{stage} failed: {detail}")),
                ));
            }
        };
        if command.role == Stm32CommandRole::Size {
            size_stdout = output.stdout.clone();
        }
        stage_duration_ms.insert(stage.to_string(), output.duration_ms);
    }
    let final_result = (|| -> GateResult<(Stm32NativeRelinkManifest, BTreeMap<String, String>)> {
        verify_fixed_seal(&manifest, request.build_root)?;
        ensure_no_upload_artifacts(request.build_root)?;
        let sketch_object =
            resolve_relative_identity(request.build_root, &manifest.mutable.sketch_object)?;
        let depfile =
            resolve_relative_identity(request.build_root, &manifest.mutable.sketch_depfile)?;
        let dependencies = parse_depfile(&depfile, &sketch_object)?;
        if !same_path(&dependencies[0], &generated_cpp_path)? {
            return Err(Stm32GateError::new(
                Stm32GateCode::DependencyMismatch,
                "new depfile does not begin with the generated sketch source",
            ));
        }
        let observed_dependencies = dependencies
            .iter()
            .skip(1)
            .map(|path| external_identity(path))
            .collect::<GateResult<Vec<_>>>()?;
        if observed_dependencies != manifest.dependency_files {
            return Err(Stm32GateError::new(
                Stm32GateCode::DependencyMismatch,
                "new sketch dependency closure differs from the sealed baseline",
            ));
        }
        manifest.source_sha256 = sha256_bytes(request.source.as_bytes());
        manifest.mutable = Stm32MutableSeal {
            generated_cpp: identity_within(request.build_root, &generated_cpp_path)?,
            sketch_object: identity_within(request.build_root, &sketch_object)?,
            sketch_depfile: identity_within(request.build_root, &depfile)?,
            map: identity_within(
                request.build_root,
                &artifact_path(request.build_root, &manifest.project_name, "map"),
            )?,
            elf: output_identity_for(request.build_root, &manifest.commands.link)?,
            bin: output_identity_for(request.build_root, &manifest.commands.objcopy_bin)?,
            hex: output_identity_for(request.build_root, &manifest.commands.objcopy_hex)?,
        };
        manifest.ordered_link_objects[0] = manifest.mutable.sketch_object.clone();
        let artifacts = [
            ("elf", &manifest.mutable.elf),
            ("bin", &manifest.mutable.bin),
            ("hex", &manifest.mutable.hex),
        ]
        .into_iter()
        .map(|(name, identity)| (name.to_string(), identity.sha256.clone()))
        .collect();
        Ok((manifest.clone(), artifacts))
    })();
    let (next_manifest, artifacts) = match final_result {
        Ok(result) => result,
        Err(error) => {
            return Err(rollback_failure(&backups, &backup_root, &dirty, error));
        }
    };
    if let Err(error) = update_dirty_marker(&dirty, &mut marker, "commit-manifest") {
        return Err(rollback_failure(&backups, &backup_root, &dirty, error));
    }
    let manifest_sha =
        match write_stm32_native_relink_manifest(request.manifest_path, &next_manifest) {
            Ok(sha) => sha,
            Err(error) => {
                return Err(rollback_failure(&backups, &backup_root, &dirty, error));
            }
        };
    cleanup_transaction(&backup_root, &dirty)?;
    Ok(Stm32RelinkResult {
        manifest_sha256: manifest_sha,
        artifact_sha256: artifacts,
        stage_duration_ms,
        size_stdout,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    const SIMPLE: &str = "#include <Arduino.h>\n\nvoid setup() {}\nvoid loop() { delay(1); }\n";
    const EDITED: &str = "#include <Arduino.h>\n\nvolatile int value = 1;\nvoid setup() {}\nvoid loop() { value++; delay(1); }\n";

    fn write(path: &Path, value: impl AsRef<[u8]>) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, value).unwrap();
    }

    fn access() -> Stm32AccessBinding {
        Stm32AccessBinding {
            contract: STM32_NATIVE_RELINK_ACCESS_CONTRACT.to_string(),
            mode: "qualification-probe".to_string(),
            authorization_key: "a".repeat(64),
            canonical_fqbn: STM32_PHASE1_FQBN.to_string(),
            core_version: STM32_PHASE1_CORE_VERSION.to_string(),
            cli_version: "arduino-cli 1.4.1".to_string(),
            toolchain_key: "stm32-gcc-14.2.1".to_string(),
            property_contract_sha256: "b".repeat(64),
        }
    }

    fn proof(source: &str) -> Stm32TranslationProof {
        Stm32TranslationProof {
            contract: STM32_TRANSLATION_PROOF_CONTRACT.to_string(),
            source_sha256: sha256_bytes(source.as_bytes()),
            analyzer_identity_sha256: "c".repeat(64),
            functions_declared_before_use: true,
            normalized_headers: vec!["arduino.h".to_string()],
        }
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        build: PathBuf,
        core: PathBuf,
        tools: PathBuf,
        manifest: PathBuf,
        capture: Option<Stm32BaselineCapture<'static>>,
    }

    // The leak is bounded to one test process and keeps Capture's borrowed
    // fixture strings/paths simple; TempDir still owns and removes all files.
    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().to_path_buf();
        let build = base.join("build");
        let core = base.join("core-package");
        let tools = base.join("toolchain");
        let project = base.join("project");
        fs::create_dir_all(&build).unwrap();
        fs::create_dir_all(&core).unwrap();
        fs::create_dir_all(&tools).unwrap();
        fs::create_dir_all(&project).unwrap();
        let ino = project.join("p_Nucleo_64.ino");
        write(&ino, SIMPLE);
        let generated = build.join("sketch/p_Nucleo_64.ino.cpp");
        let sketch_object = build.join("sketch/p_Nucleo_64.ino.cpp.o");
        let depfile = build.join("sketch/p_Nucleo_64.ino.cpp.d");
        write(
            &generated,
            format!("#line 1 \"{}\"\n{SIMPLE}", ino.display()),
        );
        write(&sketch_object, b"old-sketch-object");
        let required_source = build.join("sketch/requiredLibraries.cpp");
        let required_object = build.join("sketch/requiredLibraries.cpp.o");
        write(&required_source, b"int requiredLibraries;\n");
        write(&required_object, b"required-object");
        let mut records = Vec::<serde_json::Value>::new();
        let gxx = tools.join("bin/arm-none-eabi-g++.exe");
        let gcc = tools.join("bin/arm-none-eabi-gcc.exe");
        let objcopy = tools.join("bin/arm-none-eabi-objcopy.exe");
        let size = tools.join("bin/arm-none-eabi-size.exe");
        for tool in [&gxx, &gcc, &objcopy, &size] {
            write(tool, format!("tool:{}", tool.display()));
        }
        let build_opt = build.join("sketch/build.opt");
        write(&build_opt, b"-DTEST_BUILD_OPT\n");
        let compile_args = vec![
            gxx.to_string_lossy().into_owned(),
            format!("@{}", build_opt.display()),
            "-MMD".to_string(),
            generated.to_string_lossy().into_owned(),
            "-o".to_string(),
            sketch_object.to_string_lossy().into_owned(),
        ];
        records.push(serde_json::json!({
            "directory": build,
            "arguments": compile_args,
            "file": generated,
        }));
        let required_args = vec![
            gxx.to_string_lossy().into_owned(),
            "-c".to_string(),
            required_source.to_string_lossy().into_owned(),
            "-o".to_string(),
            required_object.to_string_lossy().into_owned(),
        ];
        records.push(serde_json::json!({
            "directory": build,
            "arguments": required_args,
            "file": required_source,
        }));
        let mut ordered = vec![sketch_object.clone(), required_object.clone()];
        for index in 0..EXPECTED_LIBRARY_CCDB_ENTRIES {
            let source = core.join(format!("libraries/SrcWrapper/source-{index}.c"));
            let object = build.join(format!("libraries/SrcWrapper/source-{index}.c.o"));
            write(&source, format!("int library_{index};\n"));
            write(&object, format!("library-object-{index}"));
            records.push(serde_json::json!({
                "directory": build,
                "arguments": [gcc.to_string_lossy(), "-c", source.to_string_lossy(), "-o", object.to_string_lossy()],
                "file": source,
            }));
            ordered.push(object);
        }
        for index in 0..6 {
            let source = core.join(format!("variants/variant-{index}.cpp"));
            let object = build.join(format!("core/variant-{index}.cpp.o"));
            write(&source, format!("int variant_{index};\n"));
            write(&object, format!("variant-object-{index}"));
            records.push(serde_json::json!({
                "directory": build,
                "arguments": [gxx.to_string_lossy(), "-c", source.to_string_lossy(), "-o", object.to_string_lossy()],
                "file": source,
            }));
            ordered.push(object);
        }
        let mut archive_members = Vec::new();
        for index in 0..EXPECTED_ARCHIVE_MEMBERS {
            let source = core.join(format!("cores/arduino/core-{index}.cpp"));
            let object = build.join(format!("core/core-{index}.cpp.o"));
            write(&source, format!("int core_{index};\n"));
            write(&object, format!("core-object-{index}"));
            let member = object.file_name().unwrap().to_string_lossy().into_owned();
            archive_members.push(member);
            records.push(serde_json::json!({
                "directory": build,
                "arguments": [gxx.to_string_lossy(), "-c", source.to_string_lossy(), "-o", object.to_string_lossy()],
                "file": source,
            }));
        }
        assert_eq!(records.len(), EXPECTED_CCDB_ENTRIES);
        assert_eq!(ordered.len(), EXPECTED_ORDERED_OBJECTS);
        let core_archive = build.join("core/core.a");
        write(&core_archive, archive_members.join("\n"));
        let variant_script = core.join("variants/ldscript.ld");
        let system_script = core.join("system/ldscript.ld");
        write(&variant_script, b"SECTIONS {}\n");
        write(&system_script, b"SECTIONS {}\n");
        let elf = build.join("p_Nucleo_64.ino.elf");
        let bin = build.join("p_Nucleo_64.ino.bin");
        let hex = build.join("p_Nucleo_64.ino.hex");
        let map = build.join("p_Nucleo_64.ino.map");
        write(&elf, b"old-elf");
        write(&bin, b"old-bin");
        write(&hex, b"old-hex");
        write(&map, b"old-map");
        let header = core.join("cores/arduino/Arduino.h");
        write(&header, b"#pragma once\nvoid delay(int);\n");
        write(
            &depfile,
            format!(
                "{}: {} {}\n",
                sketch_object.display(),
                generated.display(),
                header.display()
            ),
        );
        let mut link_args = vec![
            gcc.to_string_lossy().into_owned(),
            format!("-Wl,--default-script={}", variant_script.display()),
            format!("-Wl,--script={}", system_script.display()),
            format!("-Wl,-Map,{}", map.display()),
            "-o".to_string(),
            elf.to_string_lossy().into_owned(),
            "-Wl,--start-group".to_string(),
        ];
        link_args.extend(
            ordered
                .iter()
                .map(|path| path.to_string_lossy().into_owned()),
        );
        link_args.extend([
            core_archive.to_string_lossy().into_owned(),
            "-lc".to_string(),
            "-Wl,--end-group".to_string(),
        ]);
        let graph = Stm32CommandGraph {
            compile_sketch: Stm32CommandSpec {
                role: Stm32CommandRole::CompileSketch,
                working_directory: build.clone(),
                argv: compile_args,
            },
            link: Stm32CommandSpec {
                role: Stm32CommandRole::Link,
                working_directory: build.clone(),
                argv: link_args,
            },
            objcopy_bin: Stm32CommandSpec {
                role: Stm32CommandRole::ObjcopyBin,
                working_directory: build.clone(),
                argv: vec![
                    objcopy.to_string_lossy().into_owned(),
                    "-O".to_string(),
                    "binary".to_string(),
                    elf.to_string_lossy().into_owned(),
                    bin.to_string_lossy().into_owned(),
                ],
            },
            objcopy_hex: Stm32CommandSpec {
                role: Stm32CommandRole::ObjcopyHex,
                working_directory: build.clone(),
                argv: vec![
                    objcopy.to_string_lossy().into_owned(),
                    "-O".to_string(),
                    "ihex".to_string(),
                    elf.to_string_lossy().into_owned(),
                    hex.to_string_lossy().into_owned(),
                ],
            },
            size: Stm32CommandSpec {
                role: Stm32CommandRole::Size,
                working_directory: build.clone(),
                argv: vec![
                    size.to_string_lossy().into_owned(),
                    "-A".to_string(),
                    elf.to_string_lossy().into_owned(),
                ],
            },
        };
        let ccdb = build.join("compile_commands.json");
        write(&ccdb, serde_json::to_vec_pretty(&records).unwrap());
        let build_options = build.join("build.options.json");
        write(&build_options, b"{\"fqbn\":\"NUCLEO_F401RE\"}\n");
        let manifest = base.join("manifest.json");
        let capture = Stm32BaselineCapture {
            build_root: Box::leak(Box::new(build.clone())),
            core_root: Box::leak(Box::new(core.clone())),
            toolchain_root: Box::leak(Box::new(tools.clone())),
            ccdb_path: Box::leak(Box::new(ccdb)),
            build_options_path: Box::leak(Box::new(build_options)),
            project_name: "p_Nucleo_64.ino",
            sketch_ino_path: Box::leak(Box::new(ino)),
            source: SIMPLE,
            access: access(),
            archive_members,
            commands: graph,
        };
        Fixture {
            _temp: temp,
            build,
            core,
            tools,
            manifest,
            capture: Some(capture),
        }
    }

    #[derive(Clone)]
    struct FakeExecutor {
        calls: Rc<RefCell<Vec<Stm32CommandRole>>>,
        fail_at: Option<Stm32CommandRole>,
        add_dependency: Option<PathBuf>,
    }

    impl Stm32CommandExecutor for FakeExecutor {
        fn run(
            &mut self,
            command: &Stm32CommandSpec,
            _cancelled: &AtomicBool,
        ) -> Result<Stm32CommandOutput, String> {
            self.calls.borrow_mut().push(command.role);
            if self.fail_at == Some(command.role) {
                return Err("injected failure".to_string());
            }
            match command.role {
                Stm32CommandRole::CompileSketch => {
                    let output = command_output(command).unwrap();
                    let source = command
                        .argv
                        .iter()
                        .find(|value| value.ends_with(".ino.cpp"))
                        .map(PathBuf::from)
                        .unwrap();
                    write(
                        &output,
                        format!("object:{}", sha256_bytes(&fs::read(&source).unwrap())),
                    );
                    let mut dependencies = vec![source];
                    if let Some(extra) = &self.add_dependency {
                        dependencies.push(extra.clone());
                    } else {
                        let header = command
                            .working_directory
                            .parent()
                            .unwrap()
                            .join("core-package/cores/arduino/Arduino.h");
                        dependencies.push(header);
                    }
                    write(
                        &output.with_extension("d"),
                        format!(
                            "{}: {}\n",
                            output.display(),
                            dependencies
                                .iter()
                                .map(|path| path.to_string_lossy())
                                .collect::<Vec<_>>()
                                .join(" ")
                        ),
                    );
                }
                Stm32CommandRole::Link => {
                    let output = command_output(command).unwrap();
                    write(&output, b"new-elf");
                    let map = command
                        .argv
                        .iter()
                        .find_map(|token| token.strip_prefix("-Wl,-Map,"))
                        .unwrap();
                    write(Path::new(map), b"new-map");
                }
                Stm32CommandRole::ObjcopyBin => {
                    write(&command_output(command).unwrap(), b"new-bin")
                }
                Stm32CommandRole::ObjcopyHex => {
                    write(&command_output(command).unwrap(), b"new-hex")
                }
                Stm32CommandRole::Size => {}
            }
            Ok(Stm32CommandOutput {
                stdout: if command.role == Stm32CommandRole::Size {
                    ".text 10\n.data 2\n.bss 3\n".to_string()
                } else {
                    String::new()
                },
                stderr: String::new(),
                duration_ms: 1,
            })
        }
    }

    fn prepared() -> (Fixture, Stm32NativeRelinkManifest) {
        let mut fixture = fixture();
        let manifest =
            capture_stm32_native_relink_baseline(fixture.capture.take().unwrap()).unwrap();
        write_stm32_native_relink_manifest(&fixture.manifest, &manifest).unwrap();
        (fixture, manifest)
    }

    fn request<'a>(fixture: &'a Fixture, source: &'a str) -> Stm32RelinkRequest<'a> {
        Stm32RelinkRequest {
            manifest_path: &fixture.manifest,
            build_root: &fixture.build,
            source,
            translation_proof: proof(source),
            authorization_key: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            intent: Stm32CompileIntent::CompileOnly,
            profile: "release",
            third_party_libraries: &[],
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn captures_exact_stm32_ordered_graph() {
        let (_fixture, manifest) = prepared();
        assert_eq!(manifest.ordered_link_objects.len(), 188);
        assert_eq!(manifest.immutable_link_objects.len(), 187);
        assert_eq!(manifest.archived_ccdb_objects.len(), 24);
        assert_eq!(manifest.core_archive_members.len(), 24);
        assert_eq!(manifest.link_scripts.len(), 2);
        assert_eq!(manifest.tool_files.len(), 4);
    }

    #[test]
    fn all_non_compile_intents_execute_zero_tools() {
        for intent in [
            Stm32CompileIntent::UploadReady,
            Stm32CompileIntent::Background,
            Stm32CompileIntent::LockedReplay,
        ] {
            let calls = Rc::new(RefCell::new(Vec::new()));
            let mut executor = FakeExecutor {
                calls: calls.clone(),
                fail_at: None,
                add_dependency: None,
            };
            let cancelled = Arc::new(AtomicBool::new(false));
            let request = Stm32RelinkRequest {
                manifest_path: Path::new("missing"),
                build_root: Path::new("missing"),
                source: SIMPLE,
                translation_proof: proof(SIMPLE),
                authorization_key: &"a".repeat(64),
                intent,
                profile: "release",
                third_party_libraries: &[],
                cancelled,
            };
            let error = execute_stm32_native_relink(request, &mut executor).unwrap_err();
            assert_eq!(error.code, Stm32GateCode::IntentDenied);
            assert!(calls.borrow().is_empty());
        }
    }

    #[test]
    fn profile_library_and_access_gates_execute_zero_tools() {
        let cases = [
            (
                "debug",
                Vec::<String>::new(),
                "a".repeat(64),
                Stm32GateCode::ProfileDenied,
            ),
            (
                "release",
                vec!["Wire".to_string()],
                "a".repeat(64),
                Stm32GateCode::ThirdPartyLibrariesDenied,
            ),
            (
                "release",
                Vec::new(),
                "BAD".to_string(),
                Stm32GateCode::InvalidAccessKey,
            ),
        ];
        for (profile, libraries, key, expected) in cases {
            let calls = Rc::new(RefCell::new(Vec::new()));
            let mut executor = FakeExecutor {
                calls: calls.clone(),
                fail_at: None,
                add_dependency: None,
            };
            let request = Stm32RelinkRequest {
                manifest_path: Path::new("missing"),
                build_root: Path::new("missing"),
                source: SIMPLE,
                translation_proof: proof(SIMPLE),
                authorization_key: &key,
                intent: Stm32CompileIntent::CompileOnly,
                profile,
                third_party_libraries: &libraries,
                cancelled: Arc::new(AtomicBool::new(false)),
            };
            assert_eq!(
                execute_stm32_native_relink(request, &mut executor)
                    .unwrap_err()
                    .code,
                expected
            );
            assert!(calls.borrow().is_empty());
        }
    }

    #[test]
    fn successful_transaction_runs_five_tools_and_commits_exact_seal() {
        let (fixture, _) = prepared();
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut executor = FakeExecutor {
            calls: calls.clone(),
            fail_at: None,
            add_dependency: None,
        };
        let result = execute_stm32_native_relink(request(&fixture, EDITED), &mut executor).unwrap();
        assert_eq!(
            calls.borrow().as_slice(),
            [
                Stm32CommandRole::CompileSketch,
                Stm32CommandRole::Link,
                Stm32CommandRole::ObjcopyBin,
                Stm32CommandRole::ObjcopyHex,
                Stm32CommandRole::Size,
            ]
        );
        assert_eq!(result.artifact_sha256["bin"], sha256_bytes(b"new-bin"));
        assert_eq!(result.artifact_sha256["hex"], sha256_bytes(b"new-hex"));
        assert_eq!(result.artifact_sha256["elf"], sha256_bytes(b"new-elf"));
        assert!(result.size_stdout.contains(".text"));
        assert!(!dirty_marker_path(&fixture.manifest).exists());
        assert!(!transaction_dir(&fixture.build).exists());
        let (next, sha) = load_manifest(&fixture.manifest).unwrap();
        assert_eq!(sha, result.manifest_sha256);
        assert_eq!(next.source_sha256, sha256_bytes(EDITED.as_bytes()));
    }

    #[test]
    fn fixed_object_tamper_fails_before_tool_execution() {
        let (fixture, manifest) = prepared();
        let fixed =
            resolve_relative_identity(&fixture.build, &manifest.immutable_link_objects[0]).unwrap();
        write(&fixed, b"tampered");
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut executor = FakeExecutor {
            calls: calls.clone(),
            fail_at: None,
            add_dependency: None,
        };
        assert_eq!(
            execute_stm32_native_relink(request(&fixture, EDITED), &mut executor)
                .unwrap_err()
                .code,
            Stm32GateCode::ArtifactSealFailed
        );
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn executor_failure_rolls_back_all_mutable_files() {
        let (fixture, manifest) = prepared();
        let before = [
            &manifest.mutable.generated_cpp,
            &manifest.mutable.sketch_object,
            &manifest.mutable.sketch_depfile,
            &manifest.mutable.map,
            &manifest.mutable.elf,
            &manifest.mutable.bin,
            &manifest.mutable.hex,
        ]
        .into_iter()
        .map(|identity| {
            fs::read(resolve_relative_identity(&fixture.build, identity).unwrap()).unwrap()
        })
        .collect::<Vec<_>>();
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut executor = FakeExecutor {
            calls,
            fail_at: Some(Stm32CommandRole::Link),
            add_dependency: None,
        };
        assert_eq!(
            execute_stm32_native_relink(request(&fixture, EDITED), &mut executor)
                .unwrap_err()
                .code,
            Stm32GateCode::ExecutionFailed
        );
        let after = [
            &manifest.mutable.generated_cpp,
            &manifest.mutable.sketch_object,
            &manifest.mutable.sketch_depfile,
            &manifest.mutable.map,
            &manifest.mutable.elf,
            &manifest.mutable.bin,
            &manifest.mutable.hex,
        ]
        .into_iter()
        .map(|identity| {
            fs::read(resolve_relative_identity(&fixture.build, identity).unwrap()).unwrap()
        })
        .collect::<Vec<_>>();
        assert_eq!(before, after);
        assert!(!dirty_marker_path(&fixture.manifest).exists());
    }

    #[test]
    fn dependency_drift_rolls_back_and_rejects_seal() {
        let (fixture, _) = prepared();
        let extra = fixture.core.join("cores/arduino/Extra.h");
        write(&extra, b"#pragma once\n");
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut executor = FakeExecutor {
            calls,
            fail_at: None,
            add_dependency: Some(extra),
        };
        assert_eq!(
            execute_stm32_native_relink(request(&fixture, EDITED), &mut executor)
                .unwrap_err()
                .code,
            Stm32GateCode::DependencyMismatch
        );
        assert!(!dirty_marker_path(&fixture.manifest).exists());
    }

    #[test]
    fn stale_upload_artifact_blocks_before_tools() {
        let (fixture, _) = prepared();
        write(
            &fixture.build.join("firmware.with_bootloader.bin"),
            b"unsafe",
        );
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut executor = FakeExecutor {
            calls: calls.clone(),
            fail_at: None,
            add_dependency: None,
        };
        assert_eq!(
            execute_stm32_native_relink(request(&fixture, EDITED), &mut executor)
                .unwrap_err()
                .code,
            Stm32GateCode::ArtifactSealFailed
        );
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn translation_proof_rejects_path_sensitive_source() {
        let source =
            "#include <Arduino.h>\nvoid setup() {}\nvoid loop() { Serial.print(__FILE__); }\n";
        assert_eq!(
            proof(source).validate(source).unwrap_err().code,
            Stm32GateCode::TranslationUnsupported
        );
    }

    #[test]
    fn retained_dirty_marker_blocks_without_tool_execution() {
        let (fixture, _) = prepared();
        write(&dirty_marker_path(&fixture.manifest), b"retained");
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut executor = FakeExecutor {
            calls: calls.clone(),
            fail_at: None,
            add_dependency: None,
        };
        assert_eq!(
            execute_stm32_native_relink(request(&fixture, EDITED), &mut executor)
                .unwrap_err()
                .code,
            Stm32GateCode::DirtyBuild
        );
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn manifest_unknown_fields_fail_closed() {
        let (fixture, _) = prepared();
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&fixture.manifest).unwrap()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("futureUnsafeField".to_string(), serde_json::json!(true));
        fs::write(&fixture.manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            load_manifest(&fixture.manifest).unwrap_err().code,
            Stm32GateCode::InvalidManifest
        );
    }

    #[test]
    fn core_and_tool_roots_are_part_of_the_seal() {
        let (fixture, mut manifest) = prepared();
        manifest.toolchain_root = fixture.core.to_string_lossy().into_owned();
        write_stm32_native_relink_manifest(&fixture.manifest, &manifest).unwrap();
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut executor = FakeExecutor {
            calls: calls.clone(),
            fail_at: None,
            add_dependency: None,
        };
        assert_eq!(
            execute_stm32_native_relink(request(&fixture, EDITED), &mut executor)
                .unwrap_err()
                .code,
            Stm32GateCode::ToolOutsideManagedRoot
        );
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn capture_rejects_link_order_cardinality_change() {
        let mut fixture = fixture();
        let mut capture = fixture.capture.take().unwrap();
        let start = capture
            .commands
            .link
            .argv
            .iter()
            .position(|token| token == "-Wl,--start-group")
            .unwrap();
        capture.commands.link.argv.remove(start + 1);
        assert_eq!(
            capture_stm32_native_relink_baseline(capture)
                .unwrap_err()
                .code,
            Stm32GateCode::UnsupportedCapabilityGraph
        );
    }
}
