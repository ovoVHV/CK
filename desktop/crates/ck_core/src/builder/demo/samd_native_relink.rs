//! Isolated, fail-closed SAMD Release NativeRelink transaction engine.
//!
//! The product adapter in `demo.rs` keeps this transaction behind explicit
//! qualification/certificate access and maps the executor, final identity
//! seal, dependency signature and size parser to CK's request-scoped services.
//! The first capability class is deliberately
//! narrower than `arduino:samd:*`: one sketch object, one fixed
//! `core/variant.cpp.o`, `core/core.a`, one CMSIS math archive and one exact
//! linker script.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub(crate) const SAMD_NATIVE_RELINK_SCHEMA_VERSION: u32 = 1;
pub(crate) const SAMD_NATIVE_RELINK_ENGINE_CONTRACT: &str =
    "ck-native-relink-samd-release-compile-only-phase1-v1";
pub(crate) const SAMD_NATIVE_RELINK_CAPABILITY_CLASS: &str =
    "samd-single-sketch-fixed-variant-core-cmsis-v1";
pub(crate) const SAMD_ACCESS_KEY_CONTRACT: &str = "ck-native-relink-access-key-v1";
pub(crate) const SAMD_TRANSLATION_PROOF_CONTRACT: &str =
    "ck-direct-cpp-no-auto-prototypes-proof-v1";

const MAX_IDENTITY_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DEPFILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
static FILE_NONCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SamdCompileIntent {
    CompileOnly,
    UploadReady,
    Background,
    LockedReplay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SamdGateCode {
    IntentDenied,
    ProfileDenied,
    ResetRequired,
    InvalidManifest,
    InvalidAccessKey,
    InvalidSeal,
    InvalidPath,
    UnsafeFilesystemEntry,
    MissingFile,
    EmptyFile,
    FileTooLarge,
    CommandGraphMismatch,
    ToolOutsideManagedRoot,
    UnsupportedCapabilityGraph,
    TranslationUnsupported,
    DepfileAmbiguous,
    DepfileUnsafe,
    Cancelled,
    ExecutionFailed,
    OutputTooLarge,
    DirtyBuild,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SamdGateError {
    pub code: SamdGateCode,
    pub detail: String,
}

impl SamdGateError {
    fn new(code: SamdGateCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for SamdGateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.detail)
    }
}

impl std::error::Error for SamdGateError {}

type GateResult<T> = Result<T, SamdGateError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SamdFileIdentity {
    pub relative_path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SamdExternalFileIdentity {
    pub canonical_path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SamdAccessBinding {
    pub contract: String,
    pub mode: String,
    pub authorization_key: String,
    pub canonical_fqbn: String,
    pub build_signature: String,
    pub cli_version: String,
    pub toolchain_key: String,
    pub toolchain_identity_generation: u64,
    pub property_contract_sha256: String,
}

impl SamdAccessBinding {
    fn validate(&self) -> GateResult<()> {
        if self.contract != SAMD_ACCESS_KEY_CONTRACT
            || !matches!(self.mode.as_str(), "qualification-probe" | "certified")
            || !self.canonical_fqbn.starts_with("arduino:samd:")
            || self.canonical_fqbn.matches(':').count() < 2
            || self.build_signature.trim().is_empty()
            || self.cli_version.trim().is_empty()
            || self.toolchain_key.trim().is_empty()
            || !is_sha256_hex(&self.authorization_key)
            || !is_sha256_hex(&self.property_contract_sha256)
        {
            return Err(SamdGateError::new(
                SamdGateCode::InvalidAccessKey,
                "SAMD access binding is incomplete or outside the Release capability",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SamdTranslationProof {
    pub contract: String,
    pub source_sha256: String,
    pub translated_cpp_sha256: String,
    pub analyzer_identity_sha256: String,
    pub functions_declared_before_use: bool,
    pub normalized_headers: Vec<String>,
}

impl SamdTranslationProof {
    fn validate(&self, source: &str, translated_cpp: &str) -> GateResult<()> {
        if self.contract != SAMD_TRANSLATION_PROOF_CONTRACT
            || self.source_sha256 != sha256_bytes(source.as_bytes())
            || self.translated_cpp_sha256 != sha256_bytes(translated_cpp.as_bytes())
            || !is_sha256_hex(&self.analyzer_identity_sha256)
            || !self.functions_declared_before_use
            || self.normalized_headers != ["arduino.h"]
            || source != translated_cpp
        {
            return Err(SamdGateError::new(
                SamdGateCode::TranslationUnsupported,
                "direct C++ translation proof is missing, stale, or outside the Phase 1 subset",
            ));
        }
        // This line-oriented check is defense-in-depth, not the analyzer.  The
        // production route must create the proof with CK's trusted parser.
        let includes = source
            .lines()
            .filter_map(|line| {
                let trimmed = line.trim();
                trimmed.strip_prefix("#include").map(str::trim)
            })
            .map(|value| {
                value
                    .trim_matches(|character| matches!(character, '<' | '>' | '"'))
                    .to_ascii_lowercase()
            })
            .collect::<Vec<_>>();
        if includes != ["arduino.h"]
            || !source.contains("void setup")
            || !source.contains("void loop")
        {
            return Err(SamdGateError::new(
                SamdGateCode::TranslationUnsupported,
                "Phase 1 requires exactly Arduino.h plus setup() and loop()",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SamdCommandRole {
    CompileSketch,
    Link,
    ObjcopyBin,
    ObjcopyHex,
    Size,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SamdCommandSpec {
    pub role: SamdCommandRole,
    pub working_directory: PathBuf,
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SamdCommandGraph {
    pub compile_sketch: SamdCommandSpec,
    pub link: SamdCommandSpec,
    pub objcopy_bin: SamdCommandSpec,
    pub objcopy_hex: SamdCommandSpec,
    pub size: SamdCommandSpec,
}

impl SamdCommandGraph {
    fn ordered(&self) -> [&SamdCommandSpec; 5] {
        [
            &self.compile_sketch,
            &self.link,
            &self.objcopy_bin,
            &self.objcopy_hex,
            &self.size,
        ]
    }

    fn graph_sha256(&self) -> GateResult<String> {
        let bytes = serde_json::to_vec(self).map_err(|error| {
            SamdGateError::new(
                SamdGateCode::CommandGraphMismatch,
                format!("cannot serialize SAMD command graph: {error}"),
            )
        })?;
        Ok(sha256_bytes(&bytes))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SamdCommandIdentity {
    pub role: SamdCommandRole,
    pub argv_sha256: String,
    pub executable: SamdExternalFileIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SamdResourceSummary {
    pub program_bytes: u64,
    pub ram_bytes: u64,
    pub evidence_sha256: String,
}

impl SamdResourceSummary {
    fn validate(&self) -> GateResult<()> {
        if !is_sha256_hex(&self.evidence_sha256) {
            return Err(SamdGateError::new(
                SamdGateCode::ExecutionFailed,
                "resource evidence is not a SHA-256",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SamdOutputManifest {
    pub elf: SamdFileIdentity,
    pub map: SamdFileIdentity,
    pub bin: SamdFileIdentity,
    pub hex: SamdFileIdentity,
    pub resource: SamdResourceSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SamdCapabilityGraphManifest {
    pub graph_contract: String,
    pub command_graph_sha256: String,
    pub ccdb: SamdFileIdentity,
    pub ccdb_entry_count: usize,
    pub ccdb_sketch_entry_count: usize,
    pub ccdb_core_entry_count: usize,
    pub build_options: SamdFileIdentity,
    pub generated_cpp: SamdFileIdentity,
    pub sketch_object: SamdFileIdentity,
    pub sketch_depfile: SamdFileIdentity,
    pub fixed_objects: Vec<SamdFileIdentity>,
    pub core_archive: SamdFileIdentity,
    pub cmsis_archive: SamdExternalFileIdentity,
    pub linker_script: SamdExternalFileIdentity,
    pub commands: Vec<SamdCommandIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SamdSourceManifest {
    pub raw_sha256: String,
    pub normalized_sha256: String,
    pub translation: SamdTranslationProof,
    pub backup_file_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SamdNativeRelinkManifest {
    pub schema_version: u32,
    pub engine_contract: String,
    pub capability_class: String,
    pub profile: String,
    pub canonical_build_dir: String,
    pub project_name: String,
    pub access: SamdAccessBinding,
    pub dependency_content_signature: String,
    pub graph: SamdCapabilityGraphManifest,
    pub source: SamdSourceManifest,
    pub outputs: SamdOutputManifest,
}

impl SamdNativeRelinkManifest {
    pub(crate) fn validate_header(&self) -> GateResult<()> {
        self.access.validate()?;
        if self.schema_version != SAMD_NATIVE_RELINK_SCHEMA_VERSION
            || self.engine_contract != SAMD_NATIVE_RELINK_ENGINE_CONTRACT
            || self.capability_class != SAMD_NATIVE_RELINK_CAPABILITY_CLASS
            || self.profile != "release"
            || self.graph.graph_contract != SAMD_NATIVE_RELINK_CAPABILITY_CLASS
            || self.dependency_content_signature.trim().is_empty()
            || !safe_leaf_name(&self.project_name)
            || !self.project_name.ends_with(".ino")
            || !safe_leaf_name(&self.source.backup_file_name)
            || !is_sha256_hex(&self.source.raw_sha256)
            || !is_sha256_hex(&self.source.normalized_sha256)
            || !is_sha256_hex(&self.graph.command_graph_sha256)
        {
            return Err(SamdGateError::new(
                SamdGateCode::InvalidManifest,
                "manifest does not name the isolated SAMD Release Phase 1 contract",
            ));
        }
        lexical_absolute(Path::new(&self.canonical_build_dir))?;
        if self.graph.fixed_objects.len() != 1
            || self.graph.fixed_objects[0].relative_path.replace('\\', "/") != "core/variant.cpp.o"
            || self.graph.core_archive.relative_path.replace('\\', "/") != "core/core.a"
            || self.graph.ccdb_entry_count < 2
            || self.graph.ccdb_sketch_entry_count != 1
            || self.graph.ccdb_core_entry_count + 1 != self.graph.ccdb_entry_count
            || self.graph.commands.len() != 5
        {
            return Err(SamdGateError::new(
                SamdGateCode::UnsupportedCapabilityGraph,
                "manifest is not single sketch + fixed variant + core.a + CMSIS",
            ));
        }
        let mut relative_paths = BTreeSet::new();
        for identity in self.build_identities() {
            validate_build_identity(identity)?;
            if !relative_paths.insert(identity.relative_path.replace('\\', "/")) {
                return Err(SamdGateError::new(
                    SamdGateCode::InvalidManifest,
                    "manifest repeats a build file identity",
                ));
            }
        }
        for identity in [&self.graph.cmsis_archive, &self.graph.linker_script] {
            validate_external_identity(identity)?;
        }
        let mut command_roles = BTreeSet::new();
        for command in &self.graph.commands {
            if !command_roles.insert(command.role as u8) || !is_sha256_hex(&command.argv_sha256) {
                return Err(SamdGateError::new(
                    SamdGateCode::InvalidManifest,
                    "manifest command identities are duplicated or malformed",
                ));
            }
            validate_external_identity(&command.executable)?;
        }
        self.outputs.resource.validate()?;
        Ok(())
    }

    fn build_identities(&self) -> Vec<&SamdFileIdentity> {
        let mut values = vec![
            &self.graph.ccdb,
            &self.graph.build_options,
            &self.graph.generated_cpp,
            &self.graph.sketch_object,
            &self.graph.sketch_depfile,
            &self.graph.core_archive,
            &self.outputs.elf,
            &self.outputs.map,
            &self.outputs.bin,
            &self.outputs.hex,
        ];
        values.extend(self.graph.fixed_objects.iter());
        values
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SamdEnvironment {
    pub access: SamdAccessBinding,
    pub project_name: String,
    pub build_dir: PathBuf,
    pub managed_build_root: PathBuf,
    pub ccdb: PathBuf,
    pub build_options: PathBuf,
    pub generated_cpp: PathBuf,
    pub sketch_object: PathBuf,
    pub sketch_depfile: PathBuf,
    pub fixed_variant_object: PathBuf,
    pub core_archive: PathBuf,
    pub cmsis_archive: PathBuf,
    pub linker_script: PathBuf,
    pub elf: PathBuf,
    pub map: PathBuf,
    pub bin: PathBuf,
    pub hex: PathBuf,
    pub command_graph: SamdCommandGraph,
    pub allowed_tool_roots: Vec<PathBuf>,
    pub allowed_source_roots: Vec<PathBuf>,
    /// Native platform/Core source roots accepted for non-sketch CCDB entries.
    /// Library roots are intentionally excluded in Phase 1.
    pub allowed_core_source_roots: Vec<PathBuf>,
    pub allowed_working_roots: Vec<PathBuf>,
    pub dependency_content_signature: String,
}

#[derive(Debug, Clone)]
pub(crate) struct SamdBaselineCapture {
    pub environment: SamdEnvironment,
    pub source: String,
    pub normalized_source: String,
    pub translation: SamdTranslationProof,
    pub resource: SamdResourceSummary,
    pub backup_file_name: String,
}

#[derive(Debug, Clone)]
pub(crate) struct CapturedSamdBaseline {
    pub manifest: SamdNativeRelinkManifest,
    pub command_graph: SamdCommandGraph,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SamdFinalSealProof {
    pub access: SamdAccessBinding,
    pub immutable_graph_sha256: String,
    pub candidate_output_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SamdFinalSealRequest {
    pub access: SamdAccessBinding,
    pub immutable_graph_sha256: String,
    pub candidate_output_sha256: String,
}

pub(crate) trait SamdFinalSealGuard {
    fn proof(&self) -> &SamdFinalSealProof;

    /// Revalidate while the guard still owns the request/Core read leases.
    fn revalidate(&mut self) -> Result<(), String>;
}

pub(crate) trait SamdFinalSealer {
    type Guard: SamdFinalSealGuard;

    /// The returned guard must keep both request identity and managed package
    /// read leases alive until it is dropped after the manifest commit.
    fn acquire(&mut self, request: &SamdFinalSealRequest) -> Result<Self::Guard, String>;
}

pub(crate) trait SamdDependencyRefresher {
    fn refresh(&mut self) -> Result<String, String>;
}

pub(crate) trait SamdResourceParser {
    fn parse(&mut self, stdout: &[u8], stderr: &[u8]) -> Result<SamdResourceSummary, String>;
}

#[derive(Debug, Clone)]
pub(crate) struct SamdCommandInvocation {
    pub role: SamdCommandRole,
    pub working_directory: PathBuf,
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SamdCommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub(crate) trait SamdCommandExecutor {
    /// Production implementations must delegate to CK's managed process tree:
    /// bounded concurrent drain, request cancellation, kill and reap.
    fn execute(
        &mut self,
        invocation: &SamdCommandInvocation,
        control: &SamdRunControl,
    ) -> Result<SamdCommandOutput, String>;
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SamdRunControl {
    cancelled: Arc<AtomicBool>,
}

impl SamdRunControl {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    fn checkpoint(&self) -> GateResult<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(SamdGateError::new(
                SamdGateCode::Cancelled,
                "SAMD NativeRelinkCompileOnly was cancelled",
            ))
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SamdRunInput {
    pub environment: SamdEnvironment,
    pub managed_state_root: PathBuf,
    pub manifest_path: PathBuf,
    pub backup_path: PathBuf,
    pub intent: SamdCompileIntent,
    pub profile: String,
    pub force_rebuild: bool,
    pub cache_reset_pending: bool,
    pub attempt: u32,
    pub current_source: String,
    pub normalized_source: String,
    pub translated_cpp: String,
    pub translation: SamdTranslationProof,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SamdExecutionTimings {
    pub eligibility_ms: u128,
    pub compile_ms: u128,
    pub link_ms: u128,
    pub objcopy_ms: u128,
    pub size_ms: u128,
    pub commit_ms: u128,
    pub total_ms: u128,
}

#[derive(Debug)]
pub(crate) enum SamdNativeRelinkOutcome {
    NotEligible {
        code: SamdGateCode,
        reason: String,
    },
    Succeeded {
        manifest: SamdNativeRelinkManifest,
        resource: SamdResourceSummary,
        compiler_output: String,
        timings: SamdExecutionTimings,
    },
    DirtyFailure {
        code: SamdGateCode,
        reason: String,
        dirty_marker: PathBuf,
        clean_build_required: bool,
        build_was_cleaned: bool,
    },
    Cancelled {
        reason: String,
        build_was_cleaned: bool,
    },
    BlockedByUntrustedMarker {
        code: SamdGateCode,
        reason: String,
        dirty_marker: PathBuf,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct SamdDirtyMarker {
    schema_version: u32,
    engine_contract: String,
    run_id: String,
    previous_manifest_sha256: String,
    stage: String,
    started_unix_ms: u128,
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn safe_leaf_name(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".." && !value.contains(['/', '\\', '\0'])
}

fn safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && !path.is_absolute()
        && path.components().all(|component| {
            matches!(component, Component::Normal(_))
                && component
                    .as_os_str()
                    .to_str()
                    .is_some_and(|part| safe_leaf_name(part))
        })
}

fn path_key(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        if let Some(unc) = value.strip_prefix("//?/UNC/") {
            value = format!("//{unc}");
        } else if let Some(verbatim) = value.strip_prefix("//?/") {
            value = verbatim.to_string();
        }
    }
    // Expanded Arduino recipes commonly keep a trailing separator on `-L`
    // search roots while `Path::parent()` returns the same directory without
    // it. Treat those spellings as one lexical path, but preserve POSIX and
    // drive roots themselves.
    while value.ends_with('/')
        && value.len() > 1
        && !(value.len() == 3 && value.as_bytes()[1] == b':' && value.as_bytes()[2] == b'/')
    {
        value.pop();
    }
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn lexical_absolute(path: &Path) -> GateResult<PathBuf> {
    if !path.is_absolute() {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidPath,
            format!("path is not absolute: {}", path.display()),
        ));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str())
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(SamdGateError::new(
                    SamdGateCode::InvalidPath,
                    format!("path contains parent traversal: {}", path.display()),
                ));
            }
        }
    }
    Ok(normalized)
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn canonical_directory(path: &Path) -> GateResult<PathBuf> {
    let lexical = lexical_absolute(path)?;
    let metadata = std::fs::symlink_metadata(&lexical).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::MissingFile,
            format!("cannot inspect directory {}: {error}", lexical.display()),
        )
    })?;
    if metadata_is_reparse(&metadata) || !metadata.is_dir() {
        return Err(SamdGateError::new(
            SamdGateCode::UnsafeFilesystemEntry,
            format!("directory is not ordinary: {}", lexical.display()),
        ));
    }
    std::fs::canonicalize(&lexical).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::InvalidPath,
            format!(
                "cannot canonicalize directory {}: {error}",
                lexical.display()
            ),
        )
    })
}

fn canonical_regular_file_within(path: &Path, roots: &[PathBuf]) -> GateResult<PathBuf> {
    let lexical = lexical_absolute(path)?;
    let metadata = std::fs::symlink_metadata(&lexical).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::MissingFile,
            format!("cannot inspect file {}: {error}", lexical.display()),
        )
    })?;
    if metadata_is_reparse(&metadata) || !metadata.is_file() {
        return Err(SamdGateError::new(
            SamdGateCode::UnsafeFilesystemEntry,
            format!("file is not ordinary: {}", lexical.display()),
        ));
    }
    let canonical = std::fs::canonicalize(&lexical).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::InvalidPath,
            format!("cannot canonicalize file {}: {error}", lexical.display()),
        )
    })?;
    let mut allowed = false;
    for raw_root in roots {
        let root = canonical_directory(raw_root)?;
        if !canonical.starts_with(&root) {
            continue;
        }
        ensure_ordinary_descendant_chain(&lexical, raw_root)?;
        allowed = true;
        break;
    }
    if !allowed {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidPath,
            format!("file escaped managed roots: {}", canonical.display()),
        ));
    }
    Ok(canonical)
}

fn ensure_ordinary_descendant_chain(path: &Path, root: &Path) -> GateResult<()> {
    let path = lexical_absolute(path)?;
    let root = lexical_absolute(root)?;
    let root_key = path_key(&root);
    let mut chain = Vec::new();
    let mut current = Some(path.as_path());
    let mut found = false;
    while let Some(entry) = current {
        chain.push(entry.to_path_buf());
        if path_key(entry) == root_key {
            found = true;
            break;
        }
        current = entry.parent();
    }
    if !found {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidPath,
            format!(
                "raw file path is outside its declared root: {}",
                path.display()
            ),
        ));
    }
    for entry in chain.into_iter().rev() {
        let metadata = std::fs::symlink_metadata(&entry).map_err(|error| {
            SamdGateError::new(
                SamdGateCode::MissingFile,
                format!("cannot inspect path ancestor {}: {error}", entry.display()),
            )
        })?;
        if metadata_is_reparse(&metadata) {
            return Err(SamdGateError::new(
                SamdGateCode::UnsafeFilesystemEntry,
                format!("path crosses a reparse/symlink entry: {}", entry.display()),
            ));
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> GateResult<String> {
    let bytes = std::fs::read(path).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::MissingFile,
            format!("cannot read {}: {error}", path.display()),
        )
    })?;
    Ok(sha256_bytes(&bytes))
}

fn build_file_identity(path: &Path, build: &Path) -> GateResult<SamdFileIdentity> {
    let canonical_build = canonical_directory(build)?;
    let canonical = canonical_regular_file_within(path, std::slice::from_ref(&canonical_build))?;
    let metadata = std::fs::metadata(&canonical).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::MissingFile,
            format!("cannot read file metadata: {error}"),
        )
    })?;
    if metadata.len() == 0 {
        return Err(SamdGateError::new(
            SamdGateCode::EmptyFile,
            format!("required file is empty: {}", canonical.display()),
        ));
    }
    if metadata.len() > MAX_IDENTITY_FILE_BYTES {
        return Err(SamdGateError::new(
            SamdGateCode::FileTooLarge,
            format!("identity file exceeds 64 MiB: {}", canonical.display()),
        ));
    }
    let relative = canonical.strip_prefix(&canonical_build).map_err(|_| {
        SamdGateError::new(SamdGateCode::InvalidPath, "build file escaped build root")
    })?;
    let relative_path = relative.to_string_lossy().replace('\\', "/");
    if !safe_relative_path(&relative_path) {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidPath,
            "build identity is not a safe relative path",
        ));
    }
    Ok(SamdFileIdentity {
        relative_path,
        size: metadata.len(),
        sha256: sha256_file(&canonical)?,
    })
}

fn external_file_identity(path: &Path, roots: &[PathBuf]) -> GateResult<SamdExternalFileIdentity> {
    let canonical = canonical_regular_file_within(path, roots)?;
    let metadata = std::fs::metadata(&canonical).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::MissingFile,
            format!("cannot read external file metadata: {error}"),
        )
    })?;
    if metadata.len() == 0 {
        return Err(SamdGateError::new(
            SamdGateCode::EmptyFile,
            format!("external input is empty: {}", canonical.display()),
        ));
    }
    if metadata.len() > MAX_IDENTITY_FILE_BYTES {
        return Err(SamdGateError::new(
            SamdGateCode::FileTooLarge,
            format!(
                "external identity file exceeds 64 MiB: {}",
                canonical.display()
            ),
        ));
    }
    Ok(SamdExternalFileIdentity {
        canonical_path: canonical.to_string_lossy().into_owned(),
        size: metadata.len(),
        sha256: sha256_file(&canonical)?,
    })
}

fn validate_build_identity(identity: &SamdFileIdentity) -> GateResult<()> {
    if identity.size == 0
        || !safe_relative_path(&identity.relative_path)
        || !is_sha256_hex(&identity.sha256)
    {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidManifest,
            "malformed build file identity",
        ));
    }
    Ok(())
}

fn validate_external_identity(identity: &SamdExternalFileIdentity) -> GateResult<()> {
    lexical_absolute(Path::new(&identity.canonical_path))?;
    if identity.size == 0 || !is_sha256_hex(&identity.sha256) {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidManifest,
            "malformed external file identity",
        ));
    }
    Ok(())
}

fn command_sha256(command: &SamdCommandSpec) -> GateResult<String> {
    let bytes = serde_json::to_vec(command).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::CommandGraphMismatch,
            format!("cannot serialize command: {error}"),
        )
    })?;
    Ok(sha256_bytes(&bytes))
}

fn resolve_token_path(value: &str, working_directory: &Path) -> PathBuf {
    let path = Path::new(value);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        working_directory.join(path)
    }
}

fn path_token_count(argv: &[String], working_directory: &Path, expected: &Path) -> usize {
    let expected = path_key(expected);
    argv.iter()
        .filter(|token| path_key(&resolve_token_path(token, working_directory)) == expected)
        .count()
}

fn prefixed_path_token_count(
    argv: &[String],
    working_directory: &Path,
    prefix: &str,
    expected: &Path,
) -> usize {
    let expected = path_key(expected);
    argv.iter()
        .filter_map(|token| token.strip_prefix(prefix))
        .filter(|value| path_key(&resolve_token_path(value, working_directory)) == expected)
        .count()
}

fn command_identity(
    command: &SamdCommandSpec,
    expected_role: SamdCommandRole,
    tool_roots: &[PathBuf],
    working_roots: &[PathBuf],
) -> GateResult<SamdCommandIdentity> {
    if command.role != expected_role || command.argv.len() < 2 {
        return Err(SamdGateError::new(
            SamdGateCode::CommandGraphMismatch,
            format!("missing or mislabelled {expected_role:?} command"),
        ));
    }
    let working = canonical_directory(&command.working_directory)?;
    let working_allowed = working_roots.iter().any(|root| {
        canonical_directory(root)
            .map(|root| working.starts_with(root))
            .unwrap_or(false)
    });
    if !working_allowed {
        return Err(SamdGateError::new(
            SamdGateCode::CommandGraphMismatch,
            format!(
                "command working directory escaped managed roots: {}",
                working.display()
            ),
        ));
    }
    if command.argv.iter().any(|token| {
        token.is_empty()
            || token.contains('\0')
            || token.contains('{')
            || token.contains('}')
            || token.starts_with('@')
    }) {
        return Err(SamdGateError::new(
            SamdGateCode::CommandGraphMismatch,
            "SAMD Phase 1 rejects empty/unresolved/response-file command tokens",
        ));
    }
    let mut executable_path = resolve_token_path(&command.argv[0], &working);
    #[cfg(windows)]
    if !executable_path.is_file() && executable_path.extension().is_none() {
        let windows_executable = executable_path.with_extension("exe");
        if windows_executable.is_file() {
            executable_path = windows_executable;
        }
    }
    let executable = external_file_identity(&executable_path, tool_roots).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::ToolOutsideManagedRoot,
            format!("{expected_role:?} executable is not a managed regular file: {error}"),
        )
    })?;
    Ok(SamdCommandIdentity {
        role: expected_role,
        argv_sha256: command_sha256(command)?,
        executable,
    })
}

fn validate_command_graph(environment: &SamdEnvironment) -> GateResult<Vec<SamdCommandIdentity>> {
    let graph = &environment.command_graph;
    let expected_roles = [
        SamdCommandRole::CompileSketch,
        SamdCommandRole::Link,
        SamdCommandRole::ObjcopyBin,
        SamdCommandRole::ObjcopyHex,
        SamdCommandRole::Size,
    ];
    let identities = graph
        .ordered()
        .into_iter()
        .zip(expected_roles)
        .map(|(command, role)| {
            command_identity(
                command,
                role,
                &environment.allowed_tool_roots,
                &environment.allowed_working_roots,
            )
        })
        .collect::<GateResult<Vec<_>>>()?;

    let compile = &graph.compile_sketch;
    let compile_cwd = canonical_directory(&compile.working_directory)?;
    for flag in ["-Os", "-MMD", "-mcpu=cortex-m0plus", "-mthumb"] {
        if !compile.argv.iter().any(|token| token == flag) {
            return Err(SamdGateError::new(
                SamdGateCode::UnsupportedCapabilityGraph,
                format!("SAMD Release sketch command is missing {flag}"),
            ));
        }
    }
    if compile.argv.iter().any(|token| token == "-flto")
        || path_token_count(&compile.argv, &compile_cwd, &environment.generated_cpp) != 1
        || path_token_count(&compile.argv, &compile_cwd, &environment.sketch_object) != 1
    {
        return Err(SamdGateError::new(
            SamdGateCode::UnsupportedCapabilityGraph,
            "SAMD sketch compile command is not the non-LTO single-object Release recipe",
        ));
    }

    let link = &graph.link;
    let link_cwd = canonical_directory(&link.working_directory)?;
    let build = canonical_directory(&environment.build_dir)?;
    let sketch_index = link.argv.iter().position(|token| {
        path_key(&resolve_token_path(token, &link_cwd)) == path_key(&environment.sketch_object)
    });
    let variant_index = link.argv.iter().position(|token| {
        path_key(&resolve_token_path(token, &link_cwd))
            == path_key(&environment.fixed_variant_object)
    });
    let core_index = link.argv.iter().position(|token| {
        path_key(&resolve_token_path(token, &link_cwd)) == path_key(&environment.core_archive)
    });
    let group_start = link
        .argv
        .iter()
        .position(|token| token == "-Wl,--start-group");
    let group_end = link
        .argv
        .iter()
        .position(|token| token == "-Wl,--end-group");
    let cmsis_flag = link
        .argv
        .iter()
        .position(|token| token == "-larm_cortexM0l_math");
    let math_flag = link.argv.iter().position(|token| token == "-lm");
    let cmsis_parent = environment.cmsis_archive.parent().ok_or_else(|| {
        SamdGateError::new(SamdGateCode::InvalidPath, "CMSIS archive has no parent")
    })?;
    let cmsis_search = link.argv.iter().position(|token| {
        token.strip_prefix("-L").is_some_and(|value| {
            path_key(&resolve_token_path(value, &link_cwd)) == path_key(cmsis_parent)
        })
    });
    let linker_count =
        prefixed_path_token_count(&link.argv, &link_cwd, "-T", &environment.linker_script);
    let map_count = prefixed_path_token_count(&link.argv, &link_cwd, "-Wl,-Map,", &environment.map);
    let object_tokens = link
        .argv
        .iter()
        .filter(|token| token.to_ascii_lowercase().ends_with(".o"))
        .count();
    let archive_tokens = link
        .argv
        .iter()
        .filter(|token| token.to_ascii_lowercase().ends_with(".a"))
        .count();
    let library_flags = link
        .argv
        .iter()
        .filter(|token| token.starts_with("-l"))
        .map(String::as_str)
        .collect::<Vec<_>>();
    let library_search_roots = link
        .argv
        .iter()
        .filter_map(|token| token.strip_prefix("-L"))
        .map(|value| path_key(&resolve_token_path(value, &link_cwd)))
        .collect::<Vec<_>>();
    let expected_search_roots = vec![path_key(&build), path_key(cmsis_parent)];
    let group_slice_is_exact = matches!((group_start, group_end), (Some(start), Some(end))
        if end == start + 5
            && link.argv[start + 1].strip_prefix("-L").is_some_and(|value|
                path_key(&resolve_token_path(value, &link_cwd)) == path_key(cmsis_parent))
            && link.argv[start + 2] == "-larm_cortexM0l_math"
            && link.argv[start + 3] == "-lm"
            && path_key(&resolve_token_path(&link.argv[start + 4], &link_cwd))
                == path_key(&environment.core_archive));
    let ordered = matches!(
        (
            sketch_index,
            variant_index,
            group_start,
            cmsis_search,
            cmsis_flag,
            math_flag,
            core_index,
            group_end,
        ),
        (Some(sketch), Some(variant), Some(start), Some(search), Some(cmsis), Some(math), Some(core), Some(end))
            if sketch < start
                && variant < start
                && start < search
                && search < cmsis
                && cmsis < math
                && math < core
                && core < end
    );
    let sketch_count = path_token_count(&link.argv, &link_cwd, &environment.sketch_object);
    let variant_count = path_token_count(&link.argv, &link_cwd, &environment.fixed_variant_object);
    let core_count = path_token_count(&link.argv, &link_cwd, &environment.core_archive);
    let elf_count = path_token_count(&link.argv, &link_cwd, &environment.elf);
    let search_roots_match = library_search_roots == expected_search_roots;
    if !ordered
        || object_tokens != 2
        || archive_tokens != 1
        || library_flags != ["-larm_cortexM0l_math", "-lm"]
        || !search_roots_match
        || !group_slice_is_exact
        || sketch_count != 1
        || variant_count != 1
        || core_count != 1
        || elf_count != 1
        || linker_count != 1
        || map_count != 1
    {
        return Err(SamdGateError::new(
            SamdGateCode::UnsupportedCapabilityGraph,
            format!(
                "link graph must be sketch + fixed variant + exact linker/CMSIS group + core.a \
                 (ordered={ordered}, objects={object_tokens}, archives={archive_tokens}, \
                 libraries={library_flags:?}, search_roots_match={search_roots_match}, \
                 group_exact={group_slice_is_exact}, sketch={sketch_count}, variant={variant_count}, \
                 core={core_count}, elf={elf_count}, linker={linker_count}, map={map_count})"
            ),
        ));
    }

    for (command, input, output) in [
        (&graph.objcopy_bin, &environment.elf, &environment.bin),
        (&graph.objcopy_hex, &environment.elf, &environment.hex),
    ] {
        let cwd = canonical_directory(&command.working_directory)?;
        if path_token_count(&command.argv, &cwd, input) != 1
            || path_token_count(&command.argv, &cwd, output) != 1
        {
            return Err(SamdGateError::new(
                SamdGateCode::CommandGraphMismatch,
                format!(
                    "{:?} does not bind one ELF input and one output",
                    command.role
                ),
            ));
        }
    }
    let size_cwd = canonical_directory(&graph.size.working_directory)?;
    if path_token_count(&graph.size.argv, &size_cwd, &environment.elf) != 1 {
        return Err(SamdGateError::new(
            SamdGateCode::CommandGraphMismatch,
            "size command does not bind exactly one project ELF",
        ));
    }
    Ok(identities)
}

#[derive(Debug, Deserialize)]
struct SamdCcdbEntry {
    #[serde(default)]
    directory: String,
    #[serde(default)]
    arguments: Vec<String>,
    #[serde(default)]
    command: String,
    file: String,
}

#[derive(Debug, Clone, Copy)]
struct SamdCcdbSummary {
    entry_count: usize,
    sketch_entry_count: usize,
    core_entry_count: usize,
}

fn validate_ccdb(environment: &SamdEnvironment) -> GateResult<SamdCcdbSummary> {
    let build = canonical_directory(&environment.build_dir)?;
    let ccdb = canonical_regular_file_within(&environment.ccdb, std::slice::from_ref(&build))?;
    let metadata = std::fs::metadata(&ccdb).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::MissingFile,
            format!("cannot inspect CCDB: {error}"),
        )
    })?;
    if metadata.len() == 0 || metadata.len() > MAX_DEPFILE_BYTES {
        return Err(SamdGateError::new(
            SamdGateCode::UnsupportedCapabilityGraph,
            "SAMD CCDB is empty or exceeds 16 MiB",
        ));
    }
    let bytes = std::fs::read(&ccdb).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::MissingFile,
            format!("cannot read CCDB: {error}"),
        )
    })?;
    let entries: Vec<SamdCcdbEntry> = serde_json::from_slice(&bytes).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::UnsupportedCapabilityGraph,
            format!("cannot parse CCDB: {error}"),
        )
    })?;
    if entries.len() < 2 {
        return Err(SamdGateError::new(
            SamdGateCode::UnsupportedCapabilityGraph,
            "SAMD Phase 1 requires a complete native CCDB, not a sketch-only stub",
        ));
    }
    let mut sketch_entries = 0usize;
    let mut core_entries = 0usize;
    let mut sources = BTreeSet::new();
    for entry in &entries {
        if !entry.command.trim().is_empty()
            || entry.arguments.len() < 2
            || entry.directory.is_empty()
        {
            return Err(SamdGateError::new(
                SamdGateCode::UnsupportedCapabilityGraph,
                "SAMD CCDB must expose argv directly; command strings are not accepted",
            ));
        }
        let directory = canonical_directory(Path::new(&entry.directory))?;
        if !environment.allowed_working_roots.iter().any(|root| {
            canonical_directory(root)
                .map(|root| directory.starts_with(root))
                .unwrap_or(false)
        }) {
            return Err(SamdGateError::new(
                SamdGateCode::InvalidPath,
                "CCDB working directory escaped managed roots",
            ));
        }
        let source = resolve_token_path(&entry.file, &directory);
        let source_key = path_key(&source);
        if !sources.insert(source_key.clone()) {
            return Err(SamdGateError::new(
                SamdGateCode::UnsupportedCapabilityGraph,
                "CCDB repeats a source compile unit",
            ));
        }
        if source_key == path_key(&environment.generated_cpp) {
            sketch_entries += 1;
            if entry.arguments != environment.command_graph.compile_sketch.argv
                || path_key(&directory)
                    != path_key(&environment.command_graph.compile_sketch.working_directory)
            {
                return Err(SamdGateError::new(
                    SamdGateCode::CommandGraphMismatch,
                    "CCDB sketch argv differs from the captured Release command",
                ));
            }
        } else {
            let _ = canonical_regular_file_within(&source, &environment.allowed_core_source_roots)
                .map_err(|error| {
                    SamdGateError::new(
                        SamdGateCode::UnsupportedCapabilityGraph,
                        format!("non-sketch CCDB source is not native Core/variant: {error}"),
                    )
                })?;
            core_entries += 1;
        }
    }
    if sketch_entries != 1 || core_entries + 1 != entries.len() {
        return Err(SamdGateError::new(
            SamdGateCode::UnsupportedCapabilityGraph,
            "CCDB does not contain exactly one sketch plus native Core/variant units",
        ));
    }
    Ok(SamdCcdbSummary {
        entry_count: entries.len(),
        sketch_entry_count: sketch_entries,
        core_entry_count: core_entries,
    })
}

fn validate_environment_paths(environment: &SamdEnvironment) -> GateResult<PathBuf> {
    environment.access.validate()?;
    if !safe_leaf_name(&environment.project_name) || !environment.project_name.ends_with(".ino") {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidPath,
            "project name must be one .ino leaf",
        ));
    }
    if environment.dependency_content_signature.trim().is_empty() {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidManifest,
            "dependency content signature is empty",
        ));
    }
    let managed = canonical_directory(&environment.managed_build_root)?;
    let build = canonical_directory(&environment.build_dir)?;
    if build == managed || build.parent() != Some(managed.as_path()) {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidPath,
            "SAMD build must be a direct child of the managed build root",
        ));
    }
    let build_paths = [
        &environment.ccdb,
        &environment.build_options,
        &environment.generated_cpp,
        &environment.sketch_object,
        &environment.sketch_depfile,
        &environment.fixed_variant_object,
        &environment.core_archive,
        &environment.elf,
        &environment.map,
        &environment.bin,
        &environment.hex,
    ];
    for path in build_paths {
        let _ = canonical_regular_file_within(path, std::slice::from_ref(&build))?;
    }
    let variant = build_file_identity(&environment.fixed_variant_object, &build)?;
    let core = build_file_identity(&environment.core_archive, &build)?;
    if variant.relative_path != "core/variant.cpp.o" || core.relative_path != "core/core.a" {
        return Err(SamdGateError::new(
            SamdGateCode::UnsupportedCapabilityGraph,
            "fixed variant or Core archive is not at its native SAMD path",
        ));
    }
    let _ = external_file_identity(
        &environment.cmsis_archive,
        &environment.allowed_source_roots,
    )?;
    let _ = external_file_identity(
        &environment.linker_script,
        &environment.allowed_source_roots,
    )?;
    if environment.allowed_core_source_roots.is_empty() {
        return Err(SamdGateError::new(
            SamdGateCode::UnsupportedCapabilityGraph,
            "SAMD Phase 1 requires explicit native Core source roots",
        ));
    }
    Ok(build)
}

fn immutable_graph_sha256(manifest: &SamdNativeRelinkManifest) -> GateResult<String> {
    let payload = serde_json::to_vec(&(
        &manifest.access,
        &manifest.canonical_build_dir,
        &manifest.project_name,
        &manifest.graph.graph_contract,
        &manifest.graph.command_graph_sha256,
        &manifest.graph.ccdb,
        &manifest.graph.ccdb_entry_count,
        &manifest.graph.ccdb_sketch_entry_count,
        &manifest.graph.ccdb_core_entry_count,
        &manifest.graph.build_options,
        &manifest.graph.fixed_objects,
        &manifest.graph.core_archive,
        &manifest.graph.cmsis_archive,
        &manifest.graph.linker_script,
        &manifest.graph.commands,
    ))
    .map_err(|error| {
        SamdGateError::new(
            SamdGateCode::InvalidManifest,
            format!("cannot serialize immutable SAMD graph: {error}"),
        )
    })?;
    Ok(sha256_bytes(&payload))
}

fn output_graph_sha256(outputs: &SamdOutputManifest) -> GateResult<String> {
    let payload = serde_json::to_vec(outputs).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::InvalidManifest,
            format!("cannot serialize SAMD outputs: {error}"),
        )
    })?;
    Ok(sha256_bytes(&payload))
}

pub(crate) fn capture_samd_native_relink_baseline(
    input: SamdBaselineCapture,
) -> GateResult<CapturedSamdBaseline> {
    input.translation.validate(&input.source, &input.source)?;
    input.resource.validate()?;
    if !safe_leaf_name(&input.backup_file_name) {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidPath,
            "baseline source backup is not a safe leaf",
        ));
    }
    let build = validate_environment_paths(&input.environment)?;
    let commands = validate_command_graph(&input.environment)?;
    let ccdb_summary = validate_ccdb(&input.environment)?;
    let graph = SamdCapabilityGraphManifest {
        graph_contract: SAMD_NATIVE_RELINK_CAPABILITY_CLASS.into(),
        command_graph_sha256: input.environment.command_graph.graph_sha256()?,
        ccdb: build_file_identity(&input.environment.ccdb, &build)?,
        ccdb_entry_count: ccdb_summary.entry_count,
        ccdb_sketch_entry_count: ccdb_summary.sketch_entry_count,
        ccdb_core_entry_count: ccdb_summary.core_entry_count,
        build_options: build_file_identity(&input.environment.build_options, &build)?,
        generated_cpp: build_file_identity(&input.environment.generated_cpp, &build)?,
        sketch_object: build_file_identity(&input.environment.sketch_object, &build)?,
        sketch_depfile: build_file_identity(&input.environment.sketch_depfile, &build)?,
        fixed_objects: vec![build_file_identity(
            &input.environment.fixed_variant_object,
            &build,
        )?],
        core_archive: build_file_identity(&input.environment.core_archive, &build)?,
        cmsis_archive: external_file_identity(
            &input.environment.cmsis_archive,
            &input.environment.allowed_source_roots,
        )?,
        linker_script: external_file_identity(
            &input.environment.linker_script,
            &input.environment.allowed_source_roots,
        )?,
        commands,
    };
    let outputs = SamdOutputManifest {
        elf: build_file_identity(&input.environment.elf, &build)?,
        map: build_file_identity(&input.environment.map, &build)?,
        bin: build_file_identity(&input.environment.bin, &build)?,
        hex: build_file_identity(&input.environment.hex, &build)?,
        resource: input.resource,
    };
    let manifest = SamdNativeRelinkManifest {
        schema_version: SAMD_NATIVE_RELINK_SCHEMA_VERSION,
        engine_contract: SAMD_NATIVE_RELINK_ENGINE_CONTRACT.into(),
        capability_class: SAMD_NATIVE_RELINK_CAPABILITY_CLASS.into(),
        profile: "release".into(),
        canonical_build_dir: build.to_string_lossy().into_owned(),
        project_name: input.environment.project_name.clone(),
        access: input.environment.access.clone(),
        dependency_content_signature: input.environment.dependency_content_signature.clone(),
        graph,
        source: SamdSourceManifest {
            raw_sha256: sha256_bytes(input.source.as_bytes()),
            normalized_sha256: sha256_bytes(input.normalized_source.as_bytes()),
            translation: input.translation,
            backup_file_name: input.backup_file_name,
        },
        outputs,
    };
    manifest.validate_header()?;
    Ok(CapturedSamdBaseline {
        manifest,
        command_graph: input.environment.command_graph,
    })
}

fn identity_matches_build(
    build: &Path,
    expected: &SamdFileIdentity,
    label: &str,
) -> GateResult<()> {
    let actual = build_file_identity(&build.join(&expected.relative_path), build)?;
    if actual != *expected {
        return Err(SamdGateError::new(
            SamdGateCode::DirtyBuild,
            format!("{label} content identity changed"),
        ));
    }
    Ok(())
}

fn identity_matches_external(
    expected: &SamdExternalFileIdentity,
    roots: &[PathBuf],
    label: &str,
) -> GateResult<()> {
    let actual = external_file_identity(Path::new(&expected.canonical_path), roots)?;
    if actual != *expected {
        return Err(SamdGateError::new(
            SamdGateCode::DirtyBuild,
            format!("{label} content identity changed"),
        ));
    }
    Ok(())
}

fn validate_authenticated_environment(
    environment: &SamdEnvironment,
    manifest: &SamdNativeRelinkManifest,
) -> GateResult<PathBuf> {
    manifest.validate_header()?;
    let build = validate_environment_paths(environment)?;
    let commands = validate_command_graph(environment)?;
    let ccdb_summary = validate_ccdb(environment)?;
    if path_key(&build) != path_key(Path::new(&manifest.canonical_build_dir))
        || environment.access != manifest.access
        || environment.project_name != manifest.project_name
        || environment.dependency_content_signature != manifest.dependency_content_signature
        || environment.command_graph.graph_sha256()? != manifest.graph.command_graph_sha256
        || commands != manifest.graph.commands
        || ccdb_summary.entry_count != manifest.graph.ccdb_entry_count
        || ccdb_summary.sketch_entry_count != manifest.graph.ccdb_sketch_entry_count
        || ccdb_summary.core_entry_count != manifest.graph.ccdb_core_entry_count
    {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidManifest,
            "current Release environment differs from the authenticated baseline",
        ));
    }
    for (identity, label) in [
        (&manifest.graph.ccdb, "CCDB"),
        (&manifest.graph.build_options, "build options"),
        (&manifest.graph.generated_cpp, "generated C++"),
        (&manifest.graph.sketch_object, "sketch object"),
        (&manifest.graph.sketch_depfile, "sketch depfile"),
        (&manifest.graph.fixed_objects[0], "fixed variant object"),
        (&manifest.graph.core_archive, "Core archive"),
        (&manifest.outputs.elf, "ELF"),
        (&manifest.outputs.map, "MAP"),
        (&manifest.outputs.bin, "BIN"),
        (&manifest.outputs.hex, "HEX"),
    ] {
        identity_matches_build(&build, identity, label)?;
    }
    identity_matches_external(
        &manifest.graph.cmsis_archive,
        &environment.allowed_source_roots,
        "CMSIS archive",
    )?;
    identity_matches_external(
        &manifest.graph.linker_script,
        &environment.allowed_source_roots,
        "linker script",
    )?;
    Ok(build)
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
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
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
    std::fs::rename(source, destination)
}

fn atomic_write_regular(path: &Path, bytes: &[u8]) -> GateResult<()> {
    atomic_write_regular_with(path, bytes, atomic_replace_file)
}

fn atomic_write_regular_with<F>(path: &Path, bytes: &[u8], replace: F) -> GateResult<()>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| {
        SamdGateError::new(
            SamdGateCode::InvalidPath,
            format!("atomic destination has no parent: {}", path.display()),
        )
    })?;
    let parent = canonical_directory(parent)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            SamdGateError::new(SamdGateCode::InvalidPath, "atomic file name is not UTF-8")
        })?;
    if !safe_leaf_name(name) {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidPath,
            "atomic file name is unsafe",
        ));
    }
    if let Ok(metadata) = std::fs::symlink_metadata(path)
        && (metadata_is_reparse(&metadata) || !metadata.is_file())
    {
        return Err(SamdGateError::new(
            SamdGateCode::UnsafeFilesystemEntry,
            format!(
                "atomic destination is not an ordinary file: {}",
                path.display()
            ),
        ));
    }
    let nonce = FILE_NONCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{name}.ck-samd-native-relink-{}-{nonce}.tmp",
        std::process::id()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| {
            SamdGateError::new(
                SamdGateCode::InvalidPath,
                format!("cannot create atomic temporary file: {error}"),
            )
        })?;
    let result = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace(&temporary, path)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(SamdGateError::new(
            SamdGateCode::InvalidPath,
            format!("cannot atomically commit {}: {error}", path.display()),
        ));
    }
    Ok(())
}

fn is_stale_upload_artifact(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_lowercase();
    name.ends_with(".with_bootloader.bin")
        || name.ends_with(".with_bootloader.hex")
        || name.ends_with(".uf2")
        || name == ".ck-upload-artifacts.json"
        || name == "upload-manifest.json"
}

fn remove_stale_upload_artifacts(build: &Path) -> GateResult<()> {
    for entry in std::fs::read_dir(build).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::DirtyBuild,
            format!("cannot enumerate build outputs: {error}"),
        )
    })? {
        let entry = entry.map_err(|error| {
            SamdGateError::new(
                SamdGateCode::DirtyBuild,
                format!("cannot inspect build output entry: {error}"),
            )
        })?;
        if !is_stale_upload_artifact(&entry.file_name()) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(|error| {
            SamdGateError::new(
                SamdGateCode::DirtyBuild,
                format!("cannot inspect stale upload artifact: {error}"),
            )
        })?;
        if metadata_is_reparse(&metadata) || !metadata.is_file() {
            return Err(SamdGateError::new(
                SamdGateCode::UnsafeFilesystemEntry,
                format!(
                    "stale upload artifact is not ordinary: {}",
                    entry.path().display()
                ),
            ));
        }
        std::fs::remove_file(entry.path()).map_err(|error| {
            SamdGateError::new(
                SamdGateCode::DirtyBuild,
                format!("cannot remove stale upload artifact: {error}"),
            )
        })?;
    }
    Ok(())
}

fn ensure_no_stale_upload_artifacts(build: &Path) -> GateResult<()> {
    let stale = std::fs::read_dir(build)
        .map_err(|error| {
            SamdGateError::new(
                SamdGateCode::DirtyBuild,
                format!("cannot recheck build outputs: {error}"),
            )
        })?
        .filter_map(Result::ok)
        .find(|entry| is_stale_upload_artifact(&entry.file_name()));
    if let Some(entry) = stale {
        return Err(SamdGateError::new(
            SamdGateCode::DirtyBuild,
            format!(
                "upload-only artifact survived compile-only commit: {}",
                entry.path().display()
            ),
        ));
    }
    Ok(())
}

fn validate_manifest_files(
    manifest: &SamdNativeRelinkManifest,
    environment: &SamdEnvironment,
) -> GateResult<()> {
    let build = validate_authenticated_environment(environment, manifest)?;
    remove_stale_upload_artifacts(&build)?;
    ensure_no_stale_upload_artifacts(&build)
}

fn validate_state_paths(
    managed_state_root: &Path,
    manifest_path: &Path,
    backup_path: &Path,
) -> GateResult<PathBuf> {
    let state = canonical_directory(managed_state_root)?;
    for path in [manifest_path, backup_path] {
        let lexical = lexical_absolute(path)?;
        let parent = lexical.parent().ok_or_else(|| {
            SamdGateError::new(SamdGateCode::InvalidPath, "state file has no parent")
        })?;
        if path_key(&canonical_directory(parent)?) != path_key(&state) {
            return Err(SamdGateError::new(
                SamdGateCode::InvalidPath,
                "state files must be direct children of the managed state root",
            ));
        }
        let name = lexical
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                SamdGateError::new(SamdGateCode::InvalidPath, "state file name is not UTF-8")
            })?;
        if !safe_leaf_name(name) {
            return Err(SamdGateError::new(
                SamdGateCode::InvalidPath,
                "state file name is unsafe",
            ));
        }
    }
    if path_key(manifest_path) == path_key(backup_path) {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidPath,
            "manifest and source backup must be different files",
        ));
    }
    Ok(state)
}

pub(crate) fn commit_samd_native_relink_baseline(
    captured: &CapturedSamdBaseline,
    environment: &SamdEnvironment,
    managed_state_root: &Path,
    manifest_path: &Path,
    backup_path: &Path,
    source: &str,
) -> GateResult<()> {
    captured.manifest.validate_header()?;
    let parent = validate_state_paths(managed_state_root, manifest_path, backup_path)?;
    if backup_path.parent().map(path_key) != Some(path_key(&parent))
        || backup_path.file_name().and_then(|value| value.to_str())
            != Some(captured.manifest.source.backup_file_name.as_str())
        || sha256_bytes(source.as_bytes()) != captured.manifest.source.raw_sha256
    {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidManifest,
            "source backup path or bytes differ from captured baseline",
        ));
    }
    validate_manifest_files(&captured.manifest, environment)?;
    atomic_write_regular(backup_path, source.as_bytes())?;
    // Backup is not authoritative. Revalidate after writing it, then commit
    // the manifest as the final baseline marker.
    validate_manifest_files(&captured.manifest, environment)?;
    let payload = serde_json::to_vec_pretty(&captured.manifest).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::InvalidManifest,
            format!("cannot serialize SAMD manifest: {error}"),
        )
    })?;
    atomic_write_regular(manifest_path, &payload)
}

fn read_manifest(path: &Path) -> GateResult<(SamdNativeRelinkManifest, String)> {
    let parent = path
        .parent()
        .ok_or_else(|| SamdGateError::new(SamdGateCode::InvalidPath, "manifest has no parent"))?;
    let canonical = canonical_regular_file_within(path, &[canonical_directory(parent)?])?;
    let metadata = std::fs::metadata(&canonical).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::MissingFile,
            format!("cannot inspect manifest: {error}"),
        )
    })?;
    if metadata.len() == 0 || metadata.len() > 8 * 1024 * 1024 {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidManifest,
            "manifest is empty or exceeds 8 MiB",
        ));
    }
    let bytes = std::fs::read(&canonical).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::MissingFile,
            format!("cannot read manifest: {error}"),
        )
    })?;
    let manifest: SamdNativeRelinkManifest = serde_json::from_slice(&bytes).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::InvalidManifest,
            format!("cannot parse manifest: {error}"),
        )
    })?;
    manifest.validate_header()?;
    Ok((manifest, sha256_bytes(&bytes)))
}

fn remove_regular_file_if_present(path: &Path) -> GateResult<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata_is_reparse(&metadata) || !metadata.is_file() {
                return Err(SamdGateError::new(
                    SamdGateCode::UnsafeFilesystemEntry,
                    format!("state path is not an ordinary file: {}", path.display()),
                ));
            }
            std::fs::remove_file(path).map_err(|error| {
                SamdGateError::new(
                    SamdGateCode::DirtyBuild,
                    format!("cannot remove state file {}: {error}", path.display()),
                )
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(SamdGateError::new(
            SamdGateCode::InvalidPath,
            format!("cannot inspect state file {}: {error}", path.display()),
        )),
    }
}

pub(crate) fn invalidate_samd_native_relink_baseline(
    manifest_path: &Path,
    backup_path: &Path,
) -> GateResult<()> {
    remove_regular_file_if_present(manifest_path)?;
    remove_regular_file_if_present(backup_path)
}

fn sibling_state_path(path: &Path, suffix: &str) -> GateResult<PathBuf> {
    let parent = path
        .parent()
        .ok_or_else(|| SamdGateError::new(SamdGateCode::InvalidPath, "state path has no parent"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            SamdGateError::new(SamdGateCode::InvalidPath, "state file name is not UTF-8")
        })?;
    if !safe_leaf_name(name) || !safe_leaf_name(suffix) {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidPath,
            "state file name or suffix is unsafe",
        ));
    }
    Ok(parent.join(format!("{name}.{suffix}")))
}

pub(crate) fn samd_dirty_marker_path(manifest_path: &Path) -> GateResult<PathBuf> {
    sibling_state_path(manifest_path, "dirty")
}

/// A newly authenticated native CLI baseline supersedes an ordinary retained
/// transaction marker. Special/reparse entries remain fail-closed.
pub(crate) fn clear_recovered_samd_dirty_marker(manifest_path: &Path) -> GateResult<()> {
    let marker = samd_dirty_marker_path(manifest_path)?;
    remove_regular_file_if_present(&marker)
}

fn validate_retained_dirty_marker(marker_path: &Path, manifest_path: &Path) -> GateResult<()> {
    let metadata = std::fs::symlink_metadata(marker_path).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::InvalidManifest,
            format!("cannot inspect retained SAMD dirty marker: {error}"),
        )
    })?;
    if metadata_is_reparse(&metadata) || !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err(SamdGateError::new(
            SamdGateCode::UnsafeFilesystemEntry,
            "retained SAMD dirty marker is not a bounded ordinary file",
        ));
    }
    let bytes = std::fs::read(marker_path).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::InvalidManifest,
            format!("cannot read retained SAMD dirty marker: {error}"),
        )
    })?;
    let marker: SamdDirtyMarker = serde_json::from_slice(&bytes).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::InvalidManifest,
            format!("retained SAMD dirty marker is invalid: {error}"),
        )
    })?;
    let valid_run_id = !marker.run_id.is_empty()
        && marker.run_id.len() <= 128
        && marker
            .run_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-');
    if marker.schema_version != SAMD_NATIVE_RELINK_SCHEMA_VERSION
        || marker.engine_contract != SAMD_NATIVE_RELINK_ENGINE_CONTRACT
        || !valid_run_id
        || !is_sha256_hex(&marker.previous_manifest_sha256)
        || !matches!(
            marker.stage.as_str(),
            "prepared"
                | "compile"
                | "link"
                | "objcopy"
                | "size"
                | "commit-outputs"
                | "commit-manifest"
        )
        || marker.started_unix_ms == 0
    {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidManifest,
            "retained SAMD dirty marker is not bound to this engine transaction",
        ));
    }
    let (_, manifest_sha256) = read_manifest(manifest_path)?;
    if marker.previous_manifest_sha256 != manifest_sha256 {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidManifest,
            "retained SAMD dirty marker does not bind the current manifest",
        ));
    }
    Ok(())
}

fn write_dirty_marker(path: &Path, marker: &SamdDirtyMarker) -> GateResult<()> {
    let bytes = serde_json::to_vec_pretty(marker).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::DirtyBuild,
            format!("cannot serialize dirty marker: {error}"),
        )
    })?;
    atomic_write_regular(path, &bytes)
}

fn update_dirty_stage(path: &Path, marker: &mut SamdDirtyMarker, stage: &str) -> GateResult<()> {
    marker.stage = stage.into();
    write_dirty_marker(path, marker)
}

fn clean_managed_build_directory(build: &Path, managed_root: &Path) -> GateResult<()> {
    if !build.exists() {
        return Ok(());
    }
    let managed = canonical_directory(managed_root)?;
    let build = canonical_directory(build)?;
    if build == managed || build.parent() != Some(managed.as_path()) {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidPath,
            "refusing to clean a build that is not a direct managed child",
        ));
    }
    std::fs::remove_dir_all(&build).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::DirtyBuild,
            format!("cannot clean dirty build {}: {error}", build.display()),
        )
    })
}

fn cleanup_after_failure(input: &SamdRunInput, dirty: &Path) -> bool {
    let state_clean =
        invalidate_samd_native_relink_baseline(&input.manifest_path, &input.backup_path).is_ok();
    let build_clean = clean_managed_build_directory(
        &input.environment.build_dir,
        &input.environment.managed_build_root,
    )
    .is_ok();
    if !state_clean || !build_clean {
        return false;
    }
    remove_regular_file_if_present(dirty).is_ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ContentIdentity {
    size: u64,
    sha256: String,
}

fn content_identity(path: &Path, root: &Path) -> GateResult<ContentIdentity> {
    let canonical = canonical_regular_file_within(path, &[canonical_directory(root)?])?;
    let metadata = std::fs::metadata(&canonical).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::MissingFile,
            format!("cannot inspect transaction output: {error}"),
        )
    })?;
    if metadata.len() == 0 {
        return Err(SamdGateError::new(
            SamdGateCode::EmptyFile,
            format!("transaction output is empty: {}", canonical.display()),
        ));
    }
    Ok(ContentIdentity {
        size: metadata.len(),
        sha256: sha256_file(&canonical)?,
    })
}

fn validate_content_bindings(
    paths: &[&Path],
    root: &Path,
    expected: &[ContentIdentity],
) -> GateResult<()> {
    if paths.len() != expected.len() {
        return Err(SamdGateError::new(
            SamdGateCode::DirtyBuild,
            "transaction content binding cardinality changed",
        ));
    }
    for (path, expected) in paths.iter().zip(expected) {
        if content_identity(path, root)? != *expected {
            return Err(SamdGateError::new(
                SamdGateCode::DirtyBuild,
                format!("committed output changed: {}", path.display()),
            ));
        }
    }
    Ok(())
}

fn commit_transaction_file(source: &Path, destination: &Path, build: &Path) -> GateResult<()> {
    let _ = canonical_regular_file_within(source, &[canonical_directory(build)?])?;
    let parent = destination.parent().ok_or_else(|| {
        SamdGateError::new(
            SamdGateCode::InvalidPath,
            "transaction destination has no parent",
        )
    })?;
    let parent = canonical_directory(parent)?;
    if !parent.starts_with(canonical_directory(build)?) {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidPath,
            "transaction destination escaped build root",
        ));
    }
    if let Ok(metadata) = std::fs::symlink_metadata(destination)
        && (metadata_is_reparse(&metadata) || !metadata.is_file())
    {
        return Err(SamdGateError::new(
            SamdGateCode::UnsafeFilesystemEntry,
            "transaction destination is not an ordinary file",
        ));
    }
    atomic_replace_file(source, destination).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::DirtyBuild,
            format!(
                "cannot atomically commit {} -> {}: {error}",
                source.display(),
                destination.display()
            ),
        )
    })
}

fn replace_exact_path_token(
    argv: &[String],
    working_directory: &Path,
    old: &Path,
    new: &Path,
) -> GateResult<Vec<String>> {
    let old_key = path_key(old);
    // Transaction directories are canonicalized for containment checks. On
    // Windows that produces a `\\?\` namespace which the legacy SAMD GCC 7
    // driver does not accept reliably. Keep the canonical `PathBuf` for all
    // trust decisions, but pass the compiler-safe spelling to the process.
    let replacement = super::compiler_safe_path(new);
    let mut matches = 0usize;
    let rewritten = argv
        .iter()
        .map(|token| {
            if path_key(&resolve_token_path(token, working_directory)) == old_key {
                matches += 1;
                replacement.clone()
            } else {
                token.clone()
            }
        })
        .collect::<Vec<_>>();
    if matches != 1 {
        return Err(SamdGateError::new(
            SamdGateCode::CommandGraphMismatch,
            format!(
                "expected one exact command path {}, observed {matches}",
                old.display()
            ),
        ));
    }
    Ok(rewritten)
}

fn replace_prefixed_path_token(
    argv: &[String],
    working_directory: &Path,
    prefix: &str,
    old: &Path,
    new: &Path,
) -> GateResult<Vec<String>> {
    let old_key = path_key(old);
    let mut matches = 0usize;
    let rewritten = argv
        .iter()
        .map(|token| {
            if let Some(value) = token.strip_prefix(prefix)
                && path_key(&resolve_token_path(value, working_directory)) == old_key
            {
                matches += 1;
                format!("{prefix}{}", super::compiler_safe_path(new))
            } else {
                token.clone()
            }
        })
        .collect::<Vec<_>>();
    if matches != 1 {
        return Err(SamdGateError::new(
            SamdGateCode::CommandGraphMismatch,
            format!(
                "expected one {prefix} path {}, observed {matches}",
                old.display()
            ),
        ));
    }
    Ok(rewritten)
}

fn execute_bounded<E: SamdCommandExecutor>(
    executor: &mut E,
    invocation: SamdCommandInvocation,
    control: &SamdRunControl,
) -> GateResult<SamdCommandOutput> {
    control.checkpoint()?;
    let output = executor.execute(&invocation, control).map_err(|error| {
        if control.cancelled.load(Ordering::Acquire) {
            SamdGateError::new(SamdGateCode::Cancelled, error)
        } else {
            SamdGateError::new(
                SamdGateCode::ExecutionFailed,
                format!("{:?} failed: {error}", invocation.role),
            )
        }
    })?;
    control.checkpoint()?;
    if output.stdout.len().saturating_add(output.stderr.len()) > MAX_COMMAND_OUTPUT_BYTES {
        return Err(SamdGateError::new(
            SamdGateCode::OutputTooLarge,
            format!("{:?} output exceeded 2 MiB", invocation.role),
        ));
    }
    Ok(output)
}

fn invocation(command: &SamdCommandSpec, argv: Vec<String>) -> SamdCommandInvocation {
    SamdCommandInvocation {
        role: command.role,
        working_directory: command.working_directory.clone(),
        argv,
    }
}

#[derive(Debug, Clone)]
struct DepfileToken {
    start: usize,
    end: usize,
    decoded: String,
}

fn push_depfile_token(
    target_side: bool,
    start: &mut Option<usize>,
    end: usize,
    decoded: &mut String,
    targets: &mut Vec<DepfileToken>,
    dependencies: &mut Vec<DepfileToken>,
) {
    if let Some(token_start) = start.take() {
        let token = DepfileToken {
            start: token_start,
            end,
            decoded: std::mem::take(decoded),
        };
        if target_side {
            targets.push(token);
        } else {
            dependencies.push(token);
        }
    }
}

/// Parse only the single-rule Make depfile subset emitted by GCC.  Comments,
/// variables, secondary rules and ambiguous colons fail closed.  Byte spans
/// preserve every dependency other than the transaction source and target.
fn parse_single_rule_depfile(raw: &str) -> GateResult<(Vec<DepfileToken>, Vec<DepfileToken>)> {
    let bytes = raw.as_bytes();
    let mut targets = Vec::new();
    let mut dependencies = Vec::new();
    let mut target_side = true;
    let mut separator_seen = false;
    let mut start = None;
    let mut decoded = String::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            let newline_len = if bytes.get(index + 1) == Some(&b'\n') {
                2
            } else if bytes.get(index + 1) == Some(&b'\r') && bytes.get(index + 2) == Some(&b'\n') {
                3
            } else {
                0
            };
            if newline_len != 0 {
                push_depfile_token(
                    target_side,
                    &mut start,
                    index,
                    &mut decoded,
                    &mut targets,
                    &mut dependencies,
                );
                index += newline_len;
                continue;
            }
            if let Some(next) = bytes.get(index + 1).copied()
                && matches!(next, b' ' | b'\t' | b'#' | b':')
            {
                start.get_or_insert(index);
                decoded.push(next as char);
                index += 2;
                continue;
            }
            start.get_or_insert(index);
            decoded.push('\\');
            index += 1;
            continue;
        }
        if bytes[index].is_ascii_whitespace() {
            push_depfile_token(
                target_side,
                &mut start,
                index,
                &mut decoded,
                &mut targets,
                &mut dependencies,
            );
            index += 1;
            continue;
        }
        if matches!(bytes[index], b'#' | b'$') {
            return Err(SamdGateError::new(
                SamdGateCode::DepfileAmbiguous,
                "depfile comments and Make variables are not supported",
            ));
        }
        if bytes[index] == b':' {
            let is_drive_colon = decoded
                .as_bytes()
                .last()
                .is_some_and(u8::is_ascii_alphabetic)
                && !decoded.contains(':')
                && matches!(bytes.get(index + 1), Some(b'\\' | b'/'));
            if is_drive_colon {
                start.get_or_insert(index);
                decoded.push(':');
                index += 1;
                continue;
            }
            push_depfile_token(
                target_side,
                &mut start,
                index,
                &mut decoded,
                &mut targets,
                &mut dependencies,
            );
            if separator_seen {
                return Err(SamdGateError::new(
                    SamdGateCode::DepfileAmbiguous,
                    "depfile has multiple rules or an ambiguous colon",
                ));
            }
            separator_seen = true;
            target_side = false;
            index += 1;
            continue;
        }
        start.get_or_insert(index);
        let character = raw[index..].chars().next().ok_or_else(|| {
            SamdGateError::new(SamdGateCode::DepfileAmbiguous, "depfile is not valid UTF-8")
        })?;
        decoded.push(character);
        index += character.len_utf8();
    }
    push_depfile_token(
        target_side,
        &mut start,
        raw.len(),
        &mut decoded,
        &mut targets,
        &mut dependencies,
    );
    if !separator_seen || targets.len() != 1 || dependencies.is_empty() {
        return Err(SamdGateError::new(
            SamdGateCode::DepfileAmbiguous,
            "depfile must contain exactly one target and a non-empty dependency list",
        ));
    }
    Ok((targets, dependencies))
}

fn depfile_path(path: &Path) -> GateResult<String> {
    let value = path.to_str().ok_or_else(|| {
        SamdGateError::new(SamdGateCode::InvalidPath, "depfile path is not UTF-8")
    })?;
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            ' ' | '\t' | '#' => {
                escaped.push('\\');
                escaped.push(character);
            }
            '$' => escaped.push_str("$$"),
            other => escaped.push(other),
        }
    }
    Ok(escaped)
}

fn rewrite_transaction_depfile(
    depfile: &Path,
    compile_directory: &Path,
    transaction_root: &Path,
    transaction_object: &Path,
    canonical_object: &Path,
    transaction_source: &Path,
    canonical_source: &Path,
    allowed_dependency_roots: &[PathBuf],
) -> GateResult<()> {
    let metadata = std::fs::metadata(depfile).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::MissingFile,
            format!("cannot inspect transaction depfile: {error}"),
        )
    })?;
    if metadata.len() == 0 || metadata.len() > MAX_DEPFILE_BYTES {
        return Err(SamdGateError::new(
            SamdGateCode::DepfileAmbiguous,
            "transaction depfile is empty or exceeds 16 MiB",
        ));
    }
    let raw = std::fs::read_to_string(depfile).map_err(|error| {
        SamdGateError::new(
            SamdGateCode::DepfileAmbiguous,
            format!("cannot read transaction depfile: {error}"),
        )
    })?;
    let (targets, dependencies) = parse_single_rule_depfile(&raw)?;
    if path_key(&resolve_token_path(&targets[0].decoded, compile_directory))
        != path_key(transaction_object)
    {
        return Err(SamdGateError::new(
            SamdGateCode::DepfileAmbiguous,
            "depfile target is not the transaction sketch object",
        ));
    }
    let transaction_root_key = path_key(transaction_root);
    let transaction_source_key = path_key(transaction_source);
    let mut source_matches = Vec::new();
    for token in &dependencies {
        let path = lexical_absolute(&resolve_token_path(&token.decoded, compile_directory))?;
        if path_key(&path) == transaction_source_key {
            source_matches.push(token.clone());
            continue;
        }
        if path_key(&path).starts_with(&transaction_root_key) {
            return Err(SamdGateError::new(
                SamdGateCode::DepfileUnsafe,
                "depfile contains an unexpected transaction-local dependency",
            ));
        }
        let _ = canonical_regular_file_within(&path, allowed_dependency_roots)?;
    }
    if source_matches.len() != 1 {
        return Err(SamdGateError::new(
            SamdGateCode::DepfileAmbiguous,
            format!(
                "depfile must contain the transaction source once; observed {}",
                source_matches.len()
            ),
        ));
    }
    let mut replacements = vec![
        (
            targets[0].start,
            targets[0].end,
            depfile_path(canonical_object)?,
        ),
        (
            source_matches[0].start,
            source_matches[0].end,
            depfile_path(canonical_source)?,
        ),
    ];
    replacements.sort_by_key(|(start, _, _)| *start);
    let mut rewritten = String::with_capacity(raw.len() + 64);
    let mut cursor = 0usize;
    for (start, end, replacement) in replacements {
        if start < cursor || end < start || end > raw.len() {
            return Err(SamdGateError::new(
                SamdGateCode::DepfileAmbiguous,
                "depfile replacement spans overlap or escape the file",
            ));
        }
        rewritten.push_str(&raw[cursor..start]);
        rewritten.push_str(&replacement);
        cursor = end;
    }
    rewritten.push_str(&raw[cursor..]);
    let rewritten_key = if cfg!(windows) {
        rewritten.replace('\\', "/").to_ascii_lowercase()
    } else {
        rewritten.replace('\\', "/")
    };
    if rewritten_key.contains(&transaction_root_key) {
        return Err(SamdGateError::new(
            SamdGateCode::DepfileUnsafe,
            "rewritten depfile retained a transaction path",
        ));
    }
    let (new_targets, new_dependencies) = parse_single_rule_depfile(&rewritten)?;
    if path_key(&resolve_token_path(
        &new_targets[0].decoded,
        compile_directory,
    )) != path_key(canonical_object)
        || new_dependencies
            .iter()
            .filter(|token| {
                path_key(&resolve_token_path(&token.decoded, compile_directory))
                    == path_key(canonical_source)
            })
            .count()
            != 1
    {
        return Err(SamdGateError::new(
            SamdGateCode::DepfileAmbiguous,
            "rewritten depfile does not bind canonical sketch paths",
        ));
    }
    atomic_write_regular(depfile, rewritten.as_bytes())
}

fn validate_manifest_transition(
    previous: &SamdNativeRelinkManifest,
    next: &SamdNativeRelinkManifest,
) -> GateResult<()> {
    let mut expected = previous.clone();
    expected.dependency_content_signature = next.dependency_content_signature.clone();
    expected.graph.generated_cpp = next.graph.generated_cpp.clone();
    expected.graph.sketch_object = next.graph.sketch_object.clone();
    expected.graph.sketch_depfile = next.graph.sketch_depfile.clone();
    expected.source = next.source.clone();
    expected.outputs = next.outputs.clone();
    if expected != *next {
        return Err(SamdGateError::new(
            SamdGateCode::InvalidManifest,
            "immutable SAMD Release identity changed during the transaction",
        ));
    }
    Ok(())
}

fn transaction_run_id() -> String {
    let nonce = FILE_NONCE.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{timestamp}-{nonce}", std::process::id())
}

fn not_eligible(error: SamdGateError) -> SamdNativeRelinkOutcome {
    SamdNativeRelinkOutcome::NotEligible {
        code: error.code,
        reason: error.detail,
    }
}

fn append_output(target: &mut String, output: &SamdCommandOutput) {
    for bytes in [&output.stdout[..], &output.stderr[..]] {
        if target.len() >= MAX_COMMAND_OUTPUT_BYTES {
            break;
        }
        let remaining = MAX_COMMAND_OUTPUT_BYTES - target.len();
        let text = String::from_utf8_lossy(bytes);
        if text.len() <= remaining {
            target.push_str(&text);
        } else {
            let mut end = remaining.min(text.len());
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            target.push_str(&text[..end]);
            target.push_str("\n[SAMD NativeRelink output truncated]\n");
            break;
        }
    }
}

/// Execute the isolated SAMD Phase 1 transaction.
///
/// Cancellation is terminal and must not be converted to a CLI fallback by
/// the product adapter. Other dirty
/// failures require exactly one clean native Release rebuild.
pub(crate) fn try_samd_native_relink_compile_only<E, S, D, R>(
    input: SamdRunInput,
    control: &SamdRunControl,
    executor: &mut E,
    final_sealer: &mut S,
    dependency_refresher: &mut D,
    resource_parser: &mut R,
) -> SamdNativeRelinkOutcome
where
    E: SamdCommandExecutor,
    S: SamdFinalSealer,
    D: SamdDependencyRefresher,
    R: SamdResourceParser,
{
    let total_started = Instant::now();
    // Intent gates must run before reading state, creating a marker or calling
    // any supplied interface.
    if input.intent != SamdCompileIntent::CompileOnly {
        return SamdNativeRelinkOutcome::NotEligible {
            code: SamdGateCode::IntentDenied,
            reason: "SAMD NativeRelink accepts only CompileOnly".into(),
        };
    }
    if input.profile != "release" {
        return SamdNativeRelinkOutcome::NotEligible {
            code: SamdGateCode::ProfileDenied,
            reason: "SAMD NativeRelink Phase 1 accepts only native Release".into(),
        };
    }
    if let Err(error) = validate_state_paths(
        &input.managed_state_root,
        &input.manifest_path,
        &input.backup_path,
    ) {
        return not_eligible(error);
    }
    if input.force_rebuild || input.cache_reset_pending {
        return match invalidate_samd_native_relink_baseline(
            &input.manifest_path,
            &input.backup_path,
        ) {
            Ok(()) => SamdNativeRelinkOutcome::NotEligible {
                code: SamdGateCode::ResetRequired,
                reason: "force/cache reset invalidated the SAMD NativeRelink baseline".into(),
            },
            Err(error) => SamdNativeRelinkOutcome::DirtyFailure {
                code: error.code,
                reason: error.detail,
                dirty_marker: samd_dirty_marker_path(&input.manifest_path)
                    .unwrap_or_else(|_| input.manifest_path.with_extension("dirty")),
                clean_build_required: true,
                build_was_cleaned: clean_managed_build_directory(
                    &input.environment.build_dir,
                    &input.environment.managed_build_root,
                )
                .is_ok(),
            },
        };
    }
    if input.attempt > 0 {
        return SamdNativeRelinkOutcome::NotEligible {
            code: SamdGateCode::ResetRequired,
            reason: "fallback attempts remain on native Arduino CLI".into(),
        };
    }
    if let Err(error) = control.checkpoint() {
        return SamdNativeRelinkOutcome::Cancelled {
            reason: error.detail,
            build_was_cleaned: false,
        };
    }
    if let Err(error) = input
        .translation
        .validate(&input.current_source, &input.translated_cpp)
    {
        return not_eligible(error);
    }

    let dirty_path = match samd_dirty_marker_path(&input.manifest_path) {
        Ok(path) => path,
        Err(error) => return not_eligible(error),
    };
    if dirty_path.exists() {
        if let Err(error) = validate_retained_dirty_marker(&dirty_path, &input.manifest_path) {
            return SamdNativeRelinkOutcome::BlockedByUntrustedMarker {
                code: error.code,
                reason: error.detail,
                dirty_marker: dirty_path,
            };
        }
        let cleaned = cleanup_after_failure(&input, &dirty_path);
        return SamdNativeRelinkOutcome::DirtyFailure {
            code: SamdGateCode::DirtyBuild,
            reason: "an incomplete SAMD NativeRelink transaction was found".into(),
            dirty_marker: dirty_path,
            clean_build_required: true,
            build_was_cleaned: cleaned,
        };
    }

    let (previous, previous_manifest_sha256) = match read_manifest(&input.manifest_path) {
        Ok(value) => value,
        Err(error) => return not_eligible(error),
    };
    let backup_parent = match input.backup_path.parent() {
        Some(value) => value,
        None => {
            return not_eligible(SamdGateError::new(
                SamdGateCode::InvalidPath,
                "source backup has no parent",
            ));
        }
    };
    let backup = match canonical_regular_file_within(
        &input.backup_path,
        &[match canonical_directory(backup_parent) {
            Ok(value) => value,
            Err(error) => return not_eligible(error),
        }],
    ) {
        Ok(value) => value,
        Err(error) => return not_eligible(error),
    };
    let previous_source = match std::fs::read(&backup) {
        Ok(value) => value,
        Err(error) => {
            return not_eligible(SamdGateError::new(
                SamdGateCode::MissingFile,
                format!("cannot read source backup: {error}"),
            ));
        }
    };
    if sha256_bytes(&previous_source) != previous.source.raw_sha256
        || input
            .backup_path
            .file_name()
            .and_then(|value| value.to_str())
            != Some(previous.source.backup_file_name.as_str())
    {
        return not_eligible(SamdGateError::new(
            SamdGateCode::InvalidManifest,
            "source backup does not match the committed manifest",
        ));
    }
    if sha256_bytes(input.current_source.as_bytes()) == previous.source.raw_sha256 {
        return SamdNativeRelinkOutcome::NotEligible {
            code: SamdGateCode::InvalidManifest,
            reason: "source is unchanged; Exact replay owns this request".into(),
        };
    }
    let build = match validate_authenticated_environment(&input.environment, &previous) {
        Ok(value) => value,
        Err(error) => return not_eligible(error),
    };
    let eligibility_ms = total_started.elapsed().as_millis();
    let run_id = transaction_run_id();
    let mut dirty = SamdDirtyMarker {
        schema_version: SAMD_NATIVE_RELINK_SCHEMA_VERSION,
        engine_contract: SAMD_NATIVE_RELINK_ENGINE_CONTRACT.into(),
        run_id: run_id.clone(),
        previous_manifest_sha256,
        stage: "prepared".into(),
        started_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    };
    if let Err(error) = write_dirty_marker(&dirty_path, &dirty) {
        return not_eligible(error);
    }

    let transaction = build.join(format!(".ck-samd-native-relink-{run_id}.txn"));
    let result: GateResult<(
        CapturedSamdBaseline,
        SamdEnvironment,
        SamdResourceSummary,
        String,
        SamdExecutionTimings,
    )> = (|| {
        std::fs::create_dir(&transaction).map_err(|error| {
            SamdGateError::new(
                SamdGateCode::DirtyBuild,
                format!("cannot create transaction directory: {error}"),
            )
        })?;
        for directory in [transaction.join("sketch"), transaction.join("out")] {
            std::fs::create_dir(&directory).map_err(|error| {
                SamdGateError::new(
                    SamdGateCode::DirtyBuild,
                    format!("cannot create transaction subdirectory: {error}"),
                )
            })?;
        }
        let transaction = canonical_directory(&transaction)?;
        let source_name = input.environment.generated_cpp.file_name().ok_or_else(|| {
            SamdGateError::new(SamdGateCode::InvalidPath, "generated C++ has no file name")
        })?;
        let transaction_source = transaction.join("sketch").join(source_name);
        let transaction_object = transaction.join("out/sketch.ino.cpp.o");
        let transaction_depfile = transaction_object.with_extension("d");
        let transaction_elf = transaction.join("out/project.elf");
        let transaction_map = transaction.join("out/project.map");
        let transaction_bin = transaction.join("out/project.bin");
        let transaction_hex = transaction.join("out/project.hex");
        atomic_write_regular(&transaction_source, input.translated_cpp.as_bytes())?;

        update_dirty_stage(&dirty_path, &mut dirty, "compile")?;
        control.checkpoint()?;
        let compile = &input.environment.command_graph.compile_sketch;
        let compile_cwd = canonical_directory(&compile.working_directory)?;
        let compile_argv = replace_exact_path_token(
            &compile.argv,
            &compile_cwd,
            &input.environment.generated_cpp,
            &transaction_source,
        )?;
        let compile_argv = replace_exact_path_token(
            &compile_argv,
            &compile_cwd,
            &input.environment.sketch_object,
            &transaction_object,
        )?;
        let compile_started = Instant::now();
        let compile_output = execute_bounded(executor, invocation(compile, compile_argv), control)?;
        let compile_ms = compile_started.elapsed().as_millis();
        let mut dependency_roots = input.environment.allowed_source_roots.clone();
        dependency_roots.extend(input.environment.allowed_tool_roots.clone());
        dependency_roots.push(build.clone());
        rewrite_transaction_depfile(
            &transaction_depfile,
            &compile_cwd,
            &transaction,
            &transaction_object,
            &input.environment.sketch_object,
            &transaction_source,
            &input.environment.generated_cpp,
            &dependency_roots,
        )?;

        update_dirty_stage(&dirty_path, &mut dirty, "link")?;
        let link = &input.environment.command_graph.link;
        let link_cwd = canonical_directory(&link.working_directory)?;
        let link_argv = replace_exact_path_token(
            &link.argv,
            &link_cwd,
            &input.environment.sketch_object,
            &transaction_object,
        )?;
        let link_argv = replace_exact_path_token(
            &link_argv,
            &link_cwd,
            &input.environment.elf,
            &transaction_elf,
        )?;
        let link_argv = replace_prefixed_path_token(
            &link_argv,
            &link_cwd,
            "-Wl,-Map,",
            &input.environment.map,
            &transaction_map,
        )?;
        let link_started = Instant::now();
        let link_output = execute_bounded(executor, invocation(link, link_argv), control)?;
        let link_ms = link_started.elapsed().as_millis();

        update_dirty_stage(&dirty_path, &mut dirty, "objcopy")?;
        let objcopy_started = Instant::now();
        let bin_command = &input.environment.command_graph.objcopy_bin;
        let bin_cwd = canonical_directory(&bin_command.working_directory)?;
        let bin_argv = replace_exact_path_token(
            &bin_command.argv,
            &bin_cwd,
            &input.environment.elf,
            &transaction_elf,
        )?;
        let bin_argv = replace_exact_path_token(
            &bin_argv,
            &bin_cwd,
            &input.environment.bin,
            &transaction_bin,
        )?;
        let bin_output = execute_bounded(executor, invocation(bin_command, bin_argv), control)?;
        let hex_command = &input.environment.command_graph.objcopy_hex;
        let hex_cwd = canonical_directory(&hex_command.working_directory)?;
        let hex_argv = replace_exact_path_token(
            &hex_command.argv,
            &hex_cwd,
            &input.environment.elf,
            &transaction_elf,
        )?;
        let hex_argv = replace_exact_path_token(
            &hex_argv,
            &hex_cwd,
            &input.environment.hex,
            &transaction_hex,
        )?;
        let hex_output = execute_bounded(executor, invocation(hex_command, hex_argv), control)?;
        let objcopy_ms = objcopy_started.elapsed().as_millis();

        update_dirty_stage(&dirty_path, &mut dirty, "size")?;
        let size_command = &input.environment.command_graph.size;
        let size_cwd = canonical_directory(&size_command.working_directory)?;
        let size_argv = replace_exact_path_token(
            &size_command.argv,
            &size_cwd,
            &input.environment.elf,
            &transaction_elf,
        )?;
        let size_started = Instant::now();
        let size_output = execute_bounded(executor, invocation(size_command, size_argv), control)?;
        let size_ms = size_started.elapsed().as_millis();
        let resource = resource_parser
            .parse(&size_output.stdout, &size_output.stderr)
            .map_err(|error| {
                SamdGateError::new(
                    SamdGateCode::ExecutionFailed,
                    format!("cannot parse SAMD size output: {error}"),
                )
            })?;
        resource.validate()?;
        let mut resource_evidence = size_output.stdout.clone();
        resource_evidence.extend_from_slice(&size_output.stderr);
        if resource.evidence_sha256 != sha256_bytes(&resource_evidence) {
            return Err(SamdGateError::new(
                SamdGateCode::ExecutionFailed,
                "resource parser evidence hash does not bind the size process output",
            ));
        }

        let transaction_paths: [&Path; 7] = [
            &transaction_source,
            &transaction_object,
            &transaction_depfile,
            &transaction_elf,
            &transaction_map,
            &transaction_bin,
            &transaction_hex,
        ];
        let candidate_identities = transaction_paths
            .iter()
            .map(|path| content_identity(path, &transaction))
            .collect::<GateResult<Vec<_>>>()?;
        control.checkpoint()?;
        update_dirty_stage(&dirty_path, &mut dirty, "commit-outputs")?;
        let commit_started = Instant::now();
        for (source, destination) in [
            (&transaction_source, &input.environment.generated_cpp),
            (&transaction_object, &input.environment.sketch_object),
            (&transaction_depfile, &input.environment.sketch_depfile),
            (&transaction_elf, &input.environment.elf),
            (&transaction_map, &input.environment.map),
            (&transaction_bin, &input.environment.bin),
            (&transaction_hex, &input.environment.hex),
        ] {
            commit_transaction_file(source, destination, &build)?;
        }
        let canonical_paths: [&Path; 7] = [
            &input.environment.generated_cpp,
            &input.environment.sketch_object,
            &input.environment.sketch_depfile,
            &input.environment.elf,
            &input.environment.map,
            &input.environment.bin,
            &input.environment.hex,
        ];
        validate_content_bindings(&canonical_paths, &build, &candidate_identities)?;
        remove_stale_upload_artifacts(&build)?;

        let dependency_signature = dependency_refresher.refresh().map_err(|error| {
            SamdGateError::new(
                SamdGateCode::InvalidManifest,
                format!("cannot refresh dependency signature: {error}"),
            )
        })?;
        if dependency_signature.trim().is_empty() {
            return Err(SamdGateError::new(
                SamdGateCode::InvalidManifest,
                "refreshed dependency signature is empty",
            ));
        }
        let mut next_environment = input.environment.clone();
        next_environment.dependency_content_signature = dependency_signature;
        let next = capture_samd_native_relink_baseline(SamdBaselineCapture {
            environment: next_environment.clone(),
            source: input.current_source.clone(),
            normalized_source: input.normalized_source.clone(),
            translation: input.translation.clone(),
            resource: resource.clone(),
            backup_file_name: previous.source.backup_file_name.clone(),
        })?;
        validate_manifest_transition(&previous, &next.manifest)?;
        validate_content_bindings(&canonical_paths, &build, &candidate_identities)?;
        control.checkpoint()?;
        let immutable_graph = immutable_graph_sha256(&next.manifest)?;
        let seal_request = SamdFinalSealRequest {
            access: next.manifest.access.clone(),
            immutable_graph_sha256: immutable_graph.clone(),
            candidate_output_sha256: output_graph_sha256(&next.manifest.outputs)?,
        };
        let mut seal_guard = final_sealer.acquire(&seal_request).map_err(|error| {
            SamdGateError::new(
                SamdGateCode::InvalidSeal,
                format!("final request identity seal failed: {error}"),
            )
        })?;
        let seal_proof = seal_guard.proof();
        if seal_proof.access != seal_request.access
            || seal_proof.immutable_graph_sha256 != immutable_graph
            || seal_proof.candidate_output_sha256 != seal_request.candidate_output_sha256
        {
            return Err(SamdGateError::new(
                SamdGateCode::InvalidSeal,
                "final seal proof does not match the authenticated access/graph identity",
            ));
        }
        seal_guard.revalidate().map_err(|error| {
            SamdGateError::new(
                SamdGateCode::InvalidSeal,
                format!("final identity guard revalidation failed: {error}"),
            )
        })?;
        // External callback is untrusted: re-hash every fixed input and every
        // committed candidate before the manifest can become authoritative.
        validate_manifest_files(&next.manifest, &next_environment)?;
        validate_content_bindings(&canonical_paths, &build, &candidate_identities)?;
        ensure_no_stale_upload_artifacts(&build)?;
        update_dirty_stage(&dirty_path, &mut dirty, "commit-manifest")?;
        // Last cancellable point. Cancellation after the atomic marker belongs
        // to the next request and cannot turn a committed build into fallback.
        control.checkpoint()?;
        commit_samd_native_relink_baseline(
            &next,
            &next_environment,
            &input.managed_state_root,
            &input.manifest_path,
            &input.backup_path,
            &input.current_source,
        )?;
        // Keep the request and package read leases alive through the manifest
        // commit. The guard may be dropped only after the authoritative marker
        // is durable.
        drop(seal_guard);
        std::fs::remove_dir_all(&transaction).map_err(|error| {
            SamdGateError::new(
                SamdGateCode::DirtyBuild,
                format!("cannot remove committed transaction directory: {error}"),
            )
        })?;
        remove_regular_file_if_present(&dirty_path)?;
        let commit_ms = commit_started.elapsed().as_millis();
        let mut compiler_output = String::new();
        for output in [&compile_output, &link_output, &bin_output, &hex_output] {
            append_output(&mut compiler_output, output);
        }
        Ok((
            next,
            next_environment,
            resource,
            compiler_output,
            SamdExecutionTimings {
                eligibility_ms,
                compile_ms,
                link_ms,
                objcopy_ms,
                size_ms,
                commit_ms,
                total_ms: total_started.elapsed().as_millis(),
            },
        ))
    })();

    match result {
        Ok((captured, _environment, resource, compiler_output, timings)) => {
            SamdNativeRelinkOutcome::Succeeded {
                manifest: captured.manifest,
                resource,
                compiler_output,
                timings,
            }
        }
        Err(error) => {
            let cleaned = cleanup_after_failure(&input, &dirty_path);
            if error.code == SamdGateCode::Cancelled {
                SamdNativeRelinkOutcome::Cancelled {
                    reason: error.detail,
                    build_was_cleaned: cleaned,
                }
            } else {
                SamdNativeRelinkOutcome::DirtyFailure {
                    code: error.code,
                    reason: error.detail,
                    dirty_marker: dirty_path,
                    clean_build_required: true,
                    build_was_cleaned: cleaned,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_identity_ignores_non_root_trailing_separators() {
        assert_eq!(
            path_key(Path::new("C:/ck/cmsis/")),
            path_key(Path::new("C:/ck/cmsis"))
        );
        assert_eq!(path_key(Path::new("/")), "/");
        assert_eq!(path_key(Path::new("C:/")), path_key(Path::new("C:/")));
    }
    use std::fs;
    use tempfile::TempDir;

    const SIMPLE: &str = "#include <Arduino.h>\nvoid setup() {}\nvoid loop() {}\n";
    const EDITED: &str = "#include <Arduino.h>\nvolatile int value = 7;\nvoid setup() { value++; }\nvoid loop() { value += 2; }\n";

    fn hash(label: &str) -> String {
        sha256_bytes(label.as_bytes())
    }

    fn write(path: &Path, bytes: impl AsRef<[u8]>) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create fixture parent");
        }
        fs::write(path, bytes).expect("write fixture file");
    }

    fn proof(source: &str) -> SamdTranslationProof {
        SamdTranslationProof {
            contract: SAMD_TRANSLATION_PROOF_CONTRACT.into(),
            source_sha256: sha256_bytes(source.as_bytes()),
            translated_cpp_sha256: sha256_bytes(source.as_bytes()),
            analyzer_identity_sha256: hash("trusted-analyzer-v1"),
            functions_declared_before_use: true,
            normalized_headers: vec!["arduino.h".into()],
        }
    }

    fn command(role: SamdCommandRole, cwd: &Path, argv: Vec<String>) -> SamdCommandSpec {
        SamdCommandSpec {
            role,
            working_directory: cwd.to_path_buf(),
            argv,
        }
    }

    struct Fixture {
        _temp: TempDir,
        environment: SamdEnvironment,
        state: PathBuf,
        manifest: PathBuf,
        backup: PathBuf,
        header: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().expect("temporary fixture");
            let root = temp.path().to_path_buf();
            let managed = root.join("builds");
            let build = managed.join("samd-mkrzero");
            let state = root.join("state");
            let tools = root.join("tools");
            let sdk = root.join("sdk");
            for directory in [
                &managed,
                &build,
                &state,
                &tools,
                &sdk,
                &build.join("sketch"),
                &build.join("core"),
            ] {
                fs::create_dir_all(directory).expect("fixture directory");
            }

            let compiler = tools.join("arm-none-eabi-g++.exe");
            let objcopy = tools.join("arm-none-eabi-objcopy.exe");
            let size_tool = tools.join("arm-none-eabi-size.exe");
            write(&compiler, b"fake-g++");
            write(&objcopy, b"fake-objcopy");
            write(&size_tool, b"fake-size");

            let header = sdk.join("Arduino.h");
            let core_source = sdk.join("cores/arduino/wiring.cpp");
            let variant_source = sdk.join("variants/mkrzero/variant.cpp");
            let cmsis = sdk.join("CMSIS/Lib/GCC/libarm_cortexM0l_math.a");
            let linker = sdk.join("variants/mkrzero/flash_with_bootloader.ld");
            write(&header, b"// fake Arduino.h");
            write(&core_source, b"void fake_core() {}");
            write(&variant_source, b"void fake_variant() {}");
            write(&cmsis, b"fake-cmsis-archive");
            write(
                &linker,
                b"MEMORY { FLASH(rx) : ORIGIN = 0x2000, LENGTH = 256K }",
            );

            let ccdb = build.join("compile_commands.json");
            let build_options = build.join("build.options.json");
            let generated_cpp = build.join("sketch/Sketch.ino.cpp");
            let sketch_object = build.join("sketch/Sketch.ino.cpp.o");
            let sketch_depfile = build.join("sketch/Sketch.ino.cpp.d");
            let fixed_variant = build.join("core/variant.cpp.o");
            let core_archive = build.join("core/core.a");
            let elf = build.join("Sketch.ino.elf");
            let map = build.join("Sketch.ino.map");
            let bin = build.join("Sketch.ino.bin");
            let hex = build.join("Sketch.ino.hex");
            write(&ccdb, b"pending-ccdb");
            write(&build_options, b"{\"fqbn\":\"arduino:samd:mkrzero\"}");
            write(&generated_cpp, SIMPLE);
            write(&sketch_object, b"old-sketch-object");
            write(
                &sketch_depfile,
                format!(
                    "{}: {} {}\n",
                    sketch_object.display(),
                    generated_cpp.display(),
                    header.display()
                ),
            );
            write(&fixed_variant, b"fixed-variant-object");
            write(&core_archive, b"fixed-core-archive");
            write(&elf, b"old-elf");
            write(&map, b"old-map");
            write(&bin, b"old-bin");
            write(&hex, b"old-hex");

            let compile = command(
                SamdCommandRole::CompileSketch,
                &root,
                vec![
                    compiler.to_string_lossy().into_owned(),
                    "-mcpu=cortex-m0plus".into(),
                    "-mthumb".into(),
                    "-c".into(),
                    "-g".into(),
                    "-Os".into(),
                    "-std=gnu++11".into(),
                    "-MMD".into(),
                    generated_cpp.to_string_lossy().into_owned(),
                    "-o".into(),
                    sketch_object.to_string_lossy().into_owned(),
                ],
            );
            let link = command(
                SamdCommandRole::Link,
                &root,
                vec![
                    compiler.to_string_lossy().into_owned(),
                    format!("-L{}", build.display()),
                    "-Os".into(),
                    format!("-T{}", linker.display()),
                    format!("-Wl,-Map,{}", map.display()),
                    "--specs=nano.specs".into(),
                    "-o".into(),
                    elf.to_string_lossy().into_owned(),
                    sketch_object.to_string_lossy().into_owned(),
                    fixed_variant.to_string_lossy().into_owned(),
                    "-Wl,--start-group".into(),
                    format!("-L{}", cmsis.parent().expect("CMSIS parent").display()),
                    "-larm_cortexM0l_math".into(),
                    "-lm".into(),
                    core_archive.to_string_lossy().into_owned(),
                    "-Wl,--end-group".into(),
                ],
            );
            let bin_command = command(
                SamdCommandRole::ObjcopyBin,
                &root,
                vec![
                    objcopy.to_string_lossy().into_owned(),
                    "-O".into(),
                    "binary".into(),
                    elf.to_string_lossy().into_owned(),
                    bin.to_string_lossy().into_owned(),
                ],
            );
            let hex_command = command(
                SamdCommandRole::ObjcopyHex,
                &root,
                vec![
                    objcopy.to_string_lossy().into_owned(),
                    "-O".into(),
                    "ihex".into(),
                    "-R".into(),
                    ".eeprom".into(),
                    elf.to_string_lossy().into_owned(),
                    hex.to_string_lossy().into_owned(),
                ],
            );
            let size_command = command(
                SamdCommandRole::Size,
                &root,
                vec![
                    size_tool.to_string_lossy().into_owned(),
                    "-A".into(),
                    elf.to_string_lossy().into_owned(),
                ],
            );
            let ccdb_entries = serde_json::json!([
                {
                    "directory": root.to_string_lossy(),
                    "arguments": compile.argv,
                    "command": "",
                    "file": generated_cpp.to_string_lossy(),
                },
                {
                    "directory": root.to_string_lossy(),
                    "arguments": [
                        compiler.to_string_lossy(),
                        "-c",
                        core_source.to_string_lossy(),
                        "-o",
                        build.join("core/wiring.cpp.o").to_string_lossy(),
                    ],
                    "command": "",
                    "file": core_source.to_string_lossy(),
                },
                {
                    "directory": root.to_string_lossy(),
                    "arguments": [
                        compiler.to_string_lossy(),
                        "-c",
                        variant_source.to_string_lossy(),
                        "-o",
                        fixed_variant.to_string_lossy(),
                    ],
                    "command": "",
                    "file": variant_source.to_string_lossy(),
                }
            ]);
            write(
                &ccdb,
                serde_json::to_vec(&ccdb_entries).expect("serialize CCDB"),
            );
            let environment = SamdEnvironment {
                access: SamdAccessBinding {
                    contract: SAMD_ACCESS_KEY_CONTRACT.into(),
                    mode: "qualification-probe".into(),
                    authorization_key: hash("authorization"),
                    canonical_fqbn: "arduino:samd:mkrzero".into(),
                    build_signature: "release-build-signature".into(),
                    cli_version: "arduino-cli 1.4.0".into(),
                    toolchain_key: "arm-none-eabi-gcc@7-2017q4".into(),
                    toolchain_identity_generation: 9,
                    property_contract_sha256: hash("release-property-contract"),
                },
                project_name: "Sketch.ino".into(),
                build_dir: build.clone(),
                managed_build_root: managed,
                ccdb,
                build_options,
                generated_cpp,
                sketch_object,
                sketch_depfile,
                fixed_variant_object: fixed_variant,
                core_archive,
                cmsis_archive: cmsis,
                linker_script: linker,
                elf,
                map,
                bin,
                hex,
                command_graph: SamdCommandGraph {
                    compile_sketch: compile,
                    link,
                    objcopy_bin: bin_command,
                    objcopy_hex: hex_command,
                    size: size_command,
                },
                allowed_tool_roots: vec![tools],
                allowed_source_roots: vec![sdk.clone(), build.clone()],
                allowed_core_source_roots: vec![sdk],
                allowed_working_roots: vec![root],
                dependency_content_signature: "dependency-v1".into(),
            };
            let manifest = state.join("samd-native-relink.json");
            let backup = state.join("samd-source.ino");
            let captured = capture_samd_native_relink_baseline(SamdBaselineCapture {
                environment: environment.clone(),
                source: SIMPLE.into(),
                normalized_source: SIMPLE.into(),
                translation: proof(SIMPLE),
                resource: SamdResourceSummary {
                    program_bytes: 100,
                    ram_bytes: 20,
                    evidence_sha256: hash("baseline-size-output"),
                },
                backup_file_name: "samd-source.ino".into(),
            })
            .expect("capture baseline");
            commit_samd_native_relink_baseline(
                &captured,
                &environment,
                &state,
                &manifest,
                &backup,
                SIMPLE,
            )
            .expect("commit baseline");
            Self {
                _temp: temp,
                environment,
                state,
                manifest,
                backup,
                header,
            }
        }

        fn run_input(&self) -> SamdRunInput {
            SamdRunInput {
                environment: self.environment.clone(),
                managed_state_root: self.state.clone(),
                manifest_path: self.manifest.clone(),
                backup_path: self.backup.clone(),
                intent: SamdCompileIntent::CompileOnly,
                profile: "release".into(),
                force_rebuild: false,
                cache_reset_pending: false,
                attempt: 0,
                current_source: EDITED.into(),
                normalized_source: EDITED.into(),
                translated_cpp: EDITED.into(),
                translation: proof(EDITED),
            }
        }
    }

    #[derive(Default)]
    struct FakeExecutor {
        roles: Vec<SamdCommandRole>,
        header: PathBuf,
        cancel_after: Option<SamdCommandRole>,
        malicious_depfile: bool,
        oversized: bool,
    }

    fn argument_after(argv: &[String], flag: &str) -> PathBuf {
        let index = argv.iter().position(|value| value == flag).expect("flag");
        PathBuf::from(&argv[index + 1])
    }

    impl SamdCommandExecutor for FakeExecutor {
        fn execute(
            &mut self,
            invocation: &SamdCommandInvocation,
            control: &SamdRunControl,
        ) -> Result<SamdCommandOutput, String> {
            assert!(
                invocation
                    .argv
                    .iter()
                    .all(|token| !token.contains(r"\\?\") && !token.contains("//?/")),
                "compiler-facing SAMD arguments must not contain a Windows verbatim namespace"
            );
            self.roles.push(invocation.role);
            let output = match invocation.role {
                SamdCommandRole::CompileSketch => {
                    let object = argument_after(&invocation.argv, "-o");
                    let source = invocation
                        .argv
                        .iter()
                        .map(PathBuf::from)
                        .find(|path| path.to_string_lossy().ends_with(".ino.cpp"))
                        .expect("transaction source");
                    write(
                        &object,
                        format!("object:{}", sha256_file(&source).expect("source hash")),
                    );
                    let depfile = object.with_extension("d");
                    let mut dependencies = format!(
                        "{}: {} {}",
                        object.display(),
                        source.display(),
                        self.header.display()
                    );
                    if self.malicious_depfile {
                        let rogue = object.parent().expect("object parent").join("rogue.h");
                        write(&rogue, b"rogue");
                        dependencies.push(' ');
                        dependencies.push_str(&rogue.to_string_lossy());
                    }
                    dependencies.push('\n');
                    write(&depfile, dependencies);
                    SamdCommandOutput {
                        stdout: if self.oversized {
                            vec![b'x'; MAX_COMMAND_OUTPUT_BYTES + 1]
                        } else {
                            b"compile-ok\n".to_vec()
                        },
                        stderr: Vec::new(),
                    }
                }
                SamdCommandRole::Link => {
                    let elf = argument_after(&invocation.argv, "-o");
                    let map = invocation
                        .argv
                        .iter()
                        .find_map(|value| value.strip_prefix("-Wl,-Map,"))
                        .map(PathBuf::from)
                        .expect("transaction map");
                    write(&elf, b"new-elf-from-fixed-samd-graph");
                    write(&map, b"new-map-from-fixed-samd-graph");
                    SamdCommandOutput {
                        stdout: b"link-ok\n".to_vec(),
                        stderr: Vec::new(),
                    }
                }
                SamdCommandRole::ObjcopyBin | SamdCommandRole::ObjcopyHex => {
                    let output = PathBuf::from(invocation.argv.last().expect("objcopy output"));
                    write(
                        &output,
                        if invocation.role == SamdCommandRole::ObjcopyBin {
                            b"new-bin".as_slice()
                        } else {
                            b"new-hex".as_slice()
                        },
                    );
                    SamdCommandOutput::default()
                }
                SamdCommandRole::Size => SamdCommandOutput {
                    stdout: b".text 120\n.data 20\n.bss 30\n".to_vec(),
                    stderr: Vec::new(),
                },
            };
            if self.cancel_after == Some(invocation.role) {
                control.cancel();
            }
            Ok(output)
        }
    }

    struct EchoSealer {
        calls: usize,
        tamper: Option<PathBuf>,
        bad_proof: bool,
    }

    struct EchoSealGuard {
        proof: SamdFinalSealProof,
    }

    impl SamdFinalSealGuard for EchoSealGuard {
        fn proof(&self) -> &SamdFinalSealProof {
            &self.proof
        }

        fn revalidate(&mut self) -> Result<(), String> {
            Ok(())
        }
    }

    impl SamdFinalSealer for EchoSealer {
        type Guard = EchoSealGuard;

        fn acquire(&mut self, request: &SamdFinalSealRequest) -> Result<Self::Guard, String> {
            self.calls += 1;
            if let Some(path) = &self.tamper {
                write(path, b"tampered-after-seal");
            }
            let mut access = request.access.clone();
            if self.bad_proof {
                access.authorization_key = hash("wrong-key");
            }
            Ok(EchoSealGuard {
                proof: SamdFinalSealProof {
                    access,
                    immutable_graph_sha256: request.immutable_graph_sha256.clone(),
                    candidate_output_sha256: request.candidate_output_sha256.clone(),
                },
            })
        }
    }

    struct RevalidationFailureSealer;

    struct RevalidationFailureGuard {
        proof: SamdFinalSealProof,
    }

    impl SamdFinalSealGuard for RevalidationFailureGuard {
        fn proof(&self) -> &SamdFinalSealProof {
            &self.proof
        }

        fn revalidate(&mut self) -> Result<(), String> {
            Err("lease generation changed".into())
        }
    }

    impl SamdFinalSealer for RevalidationFailureSealer {
        type Guard = RevalidationFailureGuard;

        fn acquire(&mut self, request: &SamdFinalSealRequest) -> Result<Self::Guard, String> {
            Ok(RevalidationFailureGuard {
                proof: SamdFinalSealProof {
                    access: request.access.clone(),
                    immutable_graph_sha256: request.immutable_graph_sha256.clone(),
                    candidate_output_sha256: request.candidate_output_sha256.clone(),
                },
            })
        }
    }

    struct Refresher;

    impl SamdDependencyRefresher for Refresher {
        fn refresh(&mut self) -> Result<String, String> {
            Ok("dependency-v2".into())
        }
    }

    struct SizeParser;

    impl SamdResourceParser for SizeParser {
        fn parse(&mut self, stdout: &[u8], stderr: &[u8]) -> Result<SamdResourceSummary, String> {
            let text = String::from_utf8_lossy(stdout);
            if !text.contains(".text 120")
                || !text.contains(".data 20")
                || !text.contains(".bss 30")
            {
                return Err("missing expected sections".into());
            }
            let mut evidence = stdout.to_vec();
            evidence.extend_from_slice(stderr);
            Ok(SamdResourceSummary {
                program_bytes: 140,
                ram_bytes: 50,
                evidence_sha256: sha256_bytes(&evidence),
            })
        }
    }

    fn run(
        fixture: &Fixture,
        input: SamdRunInput,
        executor: &mut FakeExecutor,
        sealer: &mut EchoSealer,
    ) -> SamdNativeRelinkOutcome {
        try_samd_native_relink_compile_only(
            input,
            &SamdRunControl::new(),
            executor,
            sealer,
            &mut Refresher,
            &mut SizeParser,
        )
    }

    #[test]
    fn baseline_captures_exact_samd_capability_graph() {
        let fixture = Fixture::new();
        let (manifest, _) = read_manifest(&fixture.manifest).expect("manifest");
        manifest.validate_header().expect("header");
        assert_eq!(manifest.graph.fixed_objects.len(), 1);
        assert_eq!(
            manifest.graph.fixed_objects[0].relative_path,
            "core/variant.cpp.o"
        );
        assert_eq!(manifest.graph.core_archive.relative_path, "core/core.a");
        assert!(
            manifest
                .graph
                .cmsis_archive
                .canonical_path
                .ends_with("libarm_cortexM0l_math.a")
        );
        assert!(
            manifest
                .graph
                .linker_script
                .canonical_path
                .ends_with("flash_with_bootloader.ld")
        );
        assert_eq!(manifest.graph.commands.len(), 5);
        assert_eq!(manifest.graph.ccdb_entry_count, 3);
        assert_eq!(manifest.graph.ccdb_sketch_entry_count, 1);
        assert_eq!(manifest.graph.ccdb_core_entry_count, 2);
    }

    #[test]
    fn extra_link_object_is_not_the_phase1_capability() {
        let fixture = Fixture::new();
        let extra = fixture.environment.build_dir.join("core/extra.cpp.o");
        write(&extra, b"extra");
        let mut environment = fixture.environment.clone();
        environment
            .command_graph
            .link
            .argv
            .insert(9, extra.to_string_lossy().into_owned());
        let error = capture_samd_native_relink_baseline(SamdBaselineCapture {
            environment,
            source: SIMPLE.into(),
            normalized_source: SIMPLE.into(),
            translation: proof(SIMPLE),
            resource: SamdResourceSummary {
                program_bytes: 1,
                ram_bytes: 1,
                evidence_sha256: hash("size"),
            },
            backup_file_name: "samd-source.ino".into(),
        })
        .expect_err("extra object must fail");
        assert_eq!(error.code, SamdGateCode::UnsupportedCapabilityGraph);
    }

    #[test]
    fn ccdb_library_source_cannot_enter_the_native_core_set() {
        let fixture = Fixture::new();
        let root = fixture.state.parent().expect("fixture root");
        let library_source = root.join("libraries/ThirdParty/src/device.cpp");
        write(&library_source, b"void third_party() {}");
        let bytes = fs::read(&fixture.environment.ccdb).expect("CCDB");
        let mut entries: serde_json::Value = serde_json::from_slice(&bytes).expect("CCDB JSON");
        let row = &mut entries.as_array_mut().expect("CCDB array")[1];
        row["file"] = serde_json::Value::String(library_source.to_string_lossy().into_owned());
        row["arguments"][2] =
            serde_json::Value::String(library_source.to_string_lossy().into_owned());
        write(
            &fixture.environment.ccdb,
            serde_json::to_vec(&entries).expect("serialize modified CCDB"),
        );
        let error = capture_samd_native_relink_baseline(SamdBaselineCapture {
            environment: fixture.environment.clone(),
            source: SIMPLE.into(),
            normalized_source: SIMPLE.into(),
            translation: proof(SIMPLE),
            resource: SamdResourceSummary {
                program_bytes: 1,
                ram_bytes: 1,
                evidence_sha256: hash("size"),
            },
            backup_file_name: "samd-source.ino".into(),
        })
        .expect_err("library CCDB source must fail");
        assert_eq!(error.code, SamdGateCode::UnsupportedCapabilityGraph);
    }

    #[test]
    fn tool_content_change_is_rejected_before_dirty_or_execution() {
        let fixture = Fixture::new();
        let compiler = PathBuf::from(&fixture.environment.command_graph.compile_sketch.argv[0]);
        write(&compiler, b"evil-g++");
        let mut executor = FakeExecutor {
            header: fixture.header.clone(),
            ..Default::default()
        };
        let mut sealer = EchoSealer {
            calls: 0,
            tamper: None,
            bad_proof: false,
        };
        let outcome = run(&fixture, fixture.run_input(), &mut executor, &mut sealer);
        assert!(matches!(
            outcome,
            SamdNativeRelinkOutcome::NotEligible { .. }
        ));
        assert!(executor.roles.is_empty());
        assert_eq!(sealer.calls, 0);
        assert!(
            !samd_dirty_marker_path(&fixture.manifest)
                .expect("dirty path")
                .exists()
        );
    }

    #[test]
    fn forged_retained_dirty_marker_blocks_without_deleting_or_running_tools() {
        let fixture = Fixture::new();
        let dirty = samd_dirty_marker_path(&fixture.manifest).expect("dirty marker path");
        write(
            &dirty,
            br#"{"schemaVersion":1,"engineContract":"wrong-engine","runId":"1-2-3","previousManifestSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","stage":"compile","startedUnixMs":1,"unexpected":true}"#,
        );
        let mut executor = FakeExecutor {
            header: fixture.header.clone(),
            ..Default::default()
        };
        let mut sealer = EchoSealer {
            calls: 0,
            tamper: None,
            bad_proof: false,
        };
        let outcome = run(&fixture, fixture.run_input(), &mut executor, &mut sealer);
        assert!(matches!(
            outcome,
            SamdNativeRelinkOutcome::BlockedByUntrustedMarker { .. }
        ));
        assert!(fixture.environment.build_dir.is_dir());
        assert!(fixture.manifest.is_file());
        assert!(dirty.is_file());
        assert!(executor.roles.is_empty());
        assert_eq!(sealer.calls, 0);
    }

    #[test]
    fn upload_background_and_locked_intents_touch_no_state_or_tools() {
        for intent in [
            SamdCompileIntent::UploadReady,
            SamdCompileIntent::Background,
            SamdCompileIntent::LockedReplay,
        ] {
            let fixture = Fixture::new();
            let before = fs::read(&fixture.manifest).expect("manifest before");
            let mut input = fixture.run_input();
            input.intent = intent;
            let mut executor = FakeExecutor {
                header: fixture.header.clone(),
                ..Default::default()
            };
            let mut sealer = EchoSealer {
                calls: 0,
                tamper: None,
                bad_proof: false,
            };
            let outcome = run(&fixture, input, &mut executor, &mut sealer);
            assert!(matches!(
                outcome,
                SamdNativeRelinkOutcome::NotEligible {
                    code: SamdGateCode::IntentDenied,
                    ..
                }
            ));
            assert!(executor.roles.is_empty());
            assert_eq!(sealer.calls, 0);
            assert_eq!(before, fs::read(&fixture.manifest).expect("manifest after"));
            assert!(
                !samd_dirty_marker_path(&fixture.manifest)
                    .expect("dirty path")
                    .exists()
            );
        }
    }

    #[test]
    fn fake_tools_commit_complete_transaction_and_remove_upload_artifacts() {
        let fixture = Fixture::new();
        write(
            &fixture
                .environment
                .build_dir
                .join("Sketch.ino.with_bootloader.bin"),
            b"stale",
        );
        write(
            &fixture
                .environment
                .build_dir
                .join(".ck-upload-artifacts.json"),
            b"{}",
        );
        let mut executor = FakeExecutor {
            header: fixture.header.clone(),
            ..Default::default()
        };
        let mut sealer = EchoSealer {
            calls: 0,
            tamper: None,
            bad_proof: false,
        };
        let outcome = run(&fixture, fixture.run_input(), &mut executor, &mut sealer);
        let manifest = match outcome {
            SamdNativeRelinkOutcome::Succeeded {
                manifest, resource, ..
            } => {
                assert_eq!(resource.program_bytes, 140);
                manifest
            }
            other => panic!("expected success, got {other:?}"),
        };
        assert_eq!(
            executor.roles,
            [
                SamdCommandRole::CompileSketch,
                SamdCommandRole::Link,
                SamdCommandRole::ObjcopyBin,
                SamdCommandRole::ObjcopyHex,
                SamdCommandRole::Size,
            ]
        );
        assert_eq!(sealer.calls, 1);
        assert_eq!(manifest.source.raw_sha256, sha256_bytes(EDITED.as_bytes()));
        assert_eq!(manifest.dependency_content_signature, "dependency-v2");
        assert_eq!(fs::read_to_string(&fixture.backup).expect("backup"), EDITED);
        let depfile = fs::read_to_string(&fixture.environment.sketch_depfile).expect("depfile");
        assert!(!depfile.contains(".ck-samd-native-relink-"));
        assert!(
            depfile.contains(
                &fixture
                    .environment
                    .generated_cpp
                    .to_string_lossy()
                    .to_string()
            )
        );
        assert!(
            !fixture
                .environment
                .build_dir
                .join("Sketch.ino.with_bootloader.bin")
                .exists()
        );
        assert!(
            !fixture
                .environment
                .build_dir
                .join(".ck-upload-artifacts.json")
                .exists()
        );
        assert!(
            !samd_dirty_marker_path(&fixture.manifest)
                .expect("dirty path")
                .exists()
        );
        let transactions = fs::read_dir(&fixture.environment.build_dir)
            .expect("build entries")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".txn"))
            .count();
        assert_eq!(transactions, 0);
    }

    #[test]
    fn malicious_transaction_dependency_fails_dirty_and_cleans_build() {
        let fixture = Fixture::new();
        let mut executor = FakeExecutor {
            header: fixture.header.clone(),
            malicious_depfile: true,
            ..Default::default()
        };
        let mut sealer = EchoSealer {
            calls: 0,
            tamper: None,
            bad_proof: false,
        };
        let outcome = run(&fixture, fixture.run_input(), &mut executor, &mut sealer);
        assert!(matches!(
            outcome,
            SamdNativeRelinkOutcome::DirtyFailure {
                code: SamdGateCode::DepfileUnsafe,
                build_was_cleaned: true,
                ..
            }
        ));
        assert!(!fixture.environment.build_dir.exists());
        assert!(!fixture.manifest.exists());
        assert_eq!(sealer.calls, 0);
    }

    #[test]
    fn cancellation_after_compile_is_terminal_and_cleans_partial_state() {
        let fixture = Fixture::new();
        let control = SamdRunControl::new();
        let mut executor = FakeExecutor {
            header: fixture.header.clone(),
            cancel_after: Some(SamdCommandRole::CompileSketch),
            ..Default::default()
        };
        let mut sealer = EchoSealer {
            calls: 0,
            tamper: None,
            bad_proof: false,
        };
        let outcome = try_samd_native_relink_compile_only(
            fixture.run_input(),
            &control,
            &mut executor,
            &mut sealer,
            &mut Refresher,
            &mut SizeParser,
        );
        assert!(matches!(
            outcome,
            SamdNativeRelinkOutcome::Cancelled {
                build_was_cleaned: true,
                ..
            }
        ));
        assert_eq!(executor.roles, [SamdCommandRole::CompileSketch]);
        assert_eq!(sealer.calls, 0);
        assert!(!fixture.environment.build_dir.exists());
        assert!(!fixture.manifest.exists());
    }

    #[test]
    fn final_seal_tamper_is_detected_after_callback() {
        let fixture = Fixture::new();
        let mut executor = FakeExecutor {
            header: fixture.header.clone(),
            ..Default::default()
        };
        let mut sealer = EchoSealer {
            calls: 0,
            tamper: Some(fixture.environment.core_archive.clone()),
            bad_proof: false,
        };
        let outcome = run(&fixture, fixture.run_input(), &mut executor, &mut sealer);
        assert!(matches!(
            outcome,
            SamdNativeRelinkOutcome::DirtyFailure {
                code: SamdGateCode::DirtyBuild,
                build_was_cleaned: true,
                ..
            }
        ));
        assert_eq!(sealer.calls, 1);
        assert!(!fixture.manifest.exists());
        assert!(!fixture.environment.build_dir.exists());
    }

    #[test]
    fn bad_access_proof_fails_closed_after_outputs() {
        let fixture = Fixture::new();
        let mut executor = FakeExecutor {
            header: fixture.header.clone(),
            ..Default::default()
        };
        let mut sealer = EchoSealer {
            calls: 0,
            tamper: None,
            bad_proof: true,
        };
        let outcome = run(&fixture, fixture.run_input(), &mut executor, &mut sealer);
        assert!(matches!(
            outcome,
            SamdNativeRelinkOutcome::DirtyFailure {
                code: SamdGateCode::InvalidSeal,
                build_was_cleaned: true,
                ..
            }
        ));
        assert_eq!(sealer.calls, 1);
    }

    #[test]
    fn final_guard_revalidation_failure_never_commits_manifest() {
        let fixture = Fixture::new();
        let mut executor = FakeExecutor {
            header: fixture.header.clone(),
            ..Default::default()
        };
        let outcome = try_samd_native_relink_compile_only(
            fixture.run_input(),
            &SamdRunControl::new(),
            &mut executor,
            &mut RevalidationFailureSealer,
            &mut Refresher,
            &mut SizeParser,
        );
        assert!(matches!(
            outcome,
            SamdNativeRelinkOutcome::DirtyFailure {
                code: SamdGateCode::InvalidSeal,
                build_was_cleaned: true,
                ..
            }
        ));
        assert!(!fixture.manifest.exists());
        assert!(!fixture.environment.build_dir.exists());
    }

    #[test]
    fn output_limit_is_enforced_before_link() {
        let fixture = Fixture::new();
        let mut executor = FakeExecutor {
            header: fixture.header.clone(),
            oversized: true,
            ..Default::default()
        };
        let mut sealer = EchoSealer {
            calls: 0,
            tamper: None,
            bad_proof: false,
        };
        let outcome = run(&fixture, fixture.run_input(), &mut executor, &mut sealer);
        assert!(matches!(
            outcome,
            SamdNativeRelinkOutcome::DirtyFailure {
                code: SamdGateCode::OutputTooLarge,
                build_was_cleaned: true,
                ..
            }
        ));
        assert_eq!(executor.roles, [SamdCommandRole::CompileSketch]);
    }

    #[test]
    fn cache_reset_invalidates_baseline_without_running_tools() {
        let fixture = Fixture::new();
        let mut input = fixture.run_input();
        input.cache_reset_pending = true;
        let mut executor = FakeExecutor {
            header: fixture.header.clone(),
            ..Default::default()
        };
        let mut sealer = EchoSealer {
            calls: 0,
            tamper: None,
            bad_proof: false,
        };
        let outcome = run(&fixture, input, &mut executor, &mut sealer);
        assert!(matches!(
            outcome,
            SamdNativeRelinkOutcome::NotEligible {
                code: SamdGateCode::ResetRequired,
                ..
            }
        ));
        assert!(executor.roles.is_empty());
        assert!(!fixture.manifest.exists());
        assert!(!fixture.backup.exists());
        assert!(fixture.environment.build_dir.exists());
    }

    #[test]
    fn cache_reset_cannot_delete_state_outside_managed_root() {
        let fixture = Fixture::new();
        let outside = fixture
            .state
            .parent()
            .expect("fixture root")
            .join("outside");
        fs::create_dir_all(&outside).expect("outside directory");
        let valuable_manifest = outside.join("valuable.json");
        let valuable_backup = outside.join("valuable.ino");
        write(&valuable_manifest, b"valuable-manifest");
        write(&valuable_backup, b"valuable-source");
        let mut input = fixture.run_input();
        input.cache_reset_pending = true;
        input.manifest_path = valuable_manifest.clone();
        input.backup_path = valuable_backup.clone();
        let mut executor = FakeExecutor {
            header: fixture.header.clone(),
            ..Default::default()
        };
        let mut sealer = EchoSealer {
            calls: 0,
            tamper: None,
            bad_proof: false,
        };
        let outcome = run(&fixture, input, &mut executor, &mut sealer);
        assert!(matches!(
            outcome,
            SamdNativeRelinkOutcome::NotEligible {
                code: SamdGateCode::InvalidPath,
                ..
            }
        ));
        assert_eq!(
            fs::read(&valuable_manifest).expect("valuable manifest"),
            b"valuable-manifest"
        );
        assert_eq!(
            fs::read(&valuable_backup).expect("valuable backup"),
            b"valuable-source"
        );
        assert!(executor.roles.is_empty());
    }

    #[test]
    fn atomic_replace_failure_preserves_previous_destination() {
        let temp = tempfile::tempdir().expect("temp");
        let destination = temp.path().join("manifest.json");
        write(&destination, b"old-authoritative-state");
        let error =
            atomic_write_regular_with(&destination, b"new-state", |_source, _destination| {
                Err(std::io::Error::other("injected replace failure"))
            })
            .expect_err("replace must fail");
        assert_eq!(error.code, SamdGateCode::InvalidPath);
        assert_eq!(
            fs::read(&destination).expect("old destination"),
            b"old-authoritative-state"
        );
        assert_eq!(
            fs::read_dir(temp.path()).expect("entries").count(),
            1,
            "atomic temporary file must be cleaned"
        );
    }

    #[test]
    fn malformed_access_key_is_rejected_during_capture() {
        let fixture = Fixture::new();
        let mut environment = fixture.environment.clone();
        environment.access.authorization_key = "not-a-hash".into();
        let error = capture_samd_native_relink_baseline(SamdBaselineCapture {
            environment,
            source: SIMPLE.into(),
            normalized_source: SIMPLE.into(),
            translation: proof(SIMPLE),
            resource: SamdResourceSummary {
                program_bytes: 1,
                ram_bytes: 1,
                evidence_sha256: hash("size"),
            },
            backup_file_name: "samd-source.ino".into(),
        })
        .expect_err("malformed access key");
        assert_eq!(error.code, SamdGateCode::InvalidAccessKey);
    }
}
