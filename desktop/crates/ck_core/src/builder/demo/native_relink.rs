//! Fail-closed contracts for the AVR Release `NativeRelinkCompileOnly` lane.
//!
//! It authenticates a native Arduino Release baseline, decides whether a
//! generated `.ino` can be translated as ordinary C++ without Arduino's
//! automatic prototype pass, and can execute the authenticated sketch-only
//! compile/link/objcopy/size graph transactionally.  Every direct subprocess
//! is delegated to the builder's bounded, cancellation-aware process manager;
//! any mutation failure invalidates the lane and requires one clean CLI
//! fallback.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::process::Command;

pub(super) const NATIVE_RELINK_MANIFEST_SCHEMA_VERSION: u32 = 3;
pub(super) const NATIVE_RELINK_ENGINE_CONTRACT: &str =
    "ck-native-relink-avr-release-compile-only-v2";
pub(super) const NATIVE_RELINK_CAPABILITY_CLASS: &str =
    "avr-release-core-archive-plus-single-sketch";
pub(super) const NATIVE_RELINK_LIBRARY_CAPABILITY_CLASS: &str =
    "avr-release-bounded-library-objects-plus-single-sketch-v1";
pub(super) const DIRECT_CPP_TRANSLATION_CONTRACT: &str = "direct-cpp-no-auto-prototypes-v1";
pub(super) const DIRECT_CPP_IMPLICIT_ARDUINO_TRANSLATION_CONTRACT: &str =
    "direct-cpp-implicit-arduino-header-v1";
pub(super) const CK_MSTIMER2_AVR_TRANSLATION_CONTRACT: &str =
    "direct-cpp-ck-mstimer2-avr-scaffold-v1";
pub(super) const DIRECT_CPP_LIBRARY_TRANSLATION_CONTRACT: &str =
    "direct-cpp-explicit-library-includes-v1";

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const CORE_CACHE_IDENTITY_RELATIVE_PATH: &str = ".ck-core-cache.json";
pub(super) const MAX_LIBRARY_ROOTS: usize = 8;
pub(super) const MAX_LIBRARY_OBJECTS: usize = 32;
const MAX_LIBRARY_TREE_FILES: usize = 512;
const MAX_LIBRARY_TREE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PARALLEL_IDENTITY_WORKERS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum NativeRelinkGateCode {
    InvalidManifest,
    InvalidPath,
    UnsafeFilesystemEntry,
    MissingFile,
    EmptyFile,
    UnsupportedCommand,
    UnresolvedProperty,
    ToolOutsideManagedRoot,
    CcdbEmpty,
    CcdbAmbiguous,
    CcdbUnsupportedEntry,
    CcdbResponseFileUnsupported,
    CcdbOutputOutsideBuild,
    MissingSketchEntry,
    MultipleSketchEntries,
    NonCoreObject,
    OptimizationMismatch,
    LtoMismatch,
    RecipeMismatch,
    Cancelled,
    ExecutionFailed,
    DirtyBuild,
    TranslationUnsupported,
    TranslationMalformed,
    AutomaticPrototypeRequired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NativeRelinkGateError {
    pub code: NativeRelinkGateCode,
    pub detail: String,
}

impl NativeRelinkGateError {
    fn new(code: NativeRelinkGateCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for NativeRelinkGateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.detail)
    }
}

impl std::error::Error for NativeRelinkGateError {}

pub(super) type GateResult<T> = Result<T, NativeRelinkGateError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeRelinkFileIdentity {
    pub relative_path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeRelinkRecipeManifest {
    pub property_contract_sha256: String,
    pub combine_sha256: String,
    pub objcopy_eep_sha256: String,
    pub objcopy_hex_sha256: String,
    pub size_sha256: String,
    pub archive_file: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeRelinkCcdbManifest {
    pub schema: String,
    pub size: u64,
    pub sha256: String,
    pub entry_count: usize,
    pub command_graph_sha256: String,
    pub sketch_source_relative_path: String,
    pub sketch_object_relative_path: String,
    pub sketch_command_sha256: String,
    pub sketch_depfile_sha256: String,
    pub non_core_non_sketch_entry_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeRelinkIncludeManifest {
    pub headers: Vec<String>,
    pub preprocessor_fingerprint: String,
    pub synthesis_safe: bool,
}

/// One explicitly admitted Arduino library root.  The root is outside the
/// managed build directory, so its canonical identity and complete bounded
/// content tree are committed independently from compiler objects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeRelinkLibraryRootManifest {
    pub canonical_path: String,
    pub tree_sha256: String,
    pub object_count: usize,
}

/// One immutable library translation unit retained from the native Arduino
/// CLI baseline.  Vector order is linker order; it is intentionally not sorted
/// after capture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeRelinkLibraryObjectManifest {
    pub library_root_index: usize,
    pub source_relative_path: String,
    pub object: NativeRelinkFileIdentity,
    pub depfile: NativeRelinkFileIdentity,
    pub command_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeRelinkSourceManifest {
    pub raw_sha256: String,
    pub normalized_sha256: String,
    pub backup_relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeRelinkOutputManifest {
    pub artifacts: Vec<NativeRelinkFileIdentity>,
    pub eep: NativeRelinkFileIdentity,
    pub size_summary: Vec<String>,
}

/// Independent commit marker for compile-only native relinking.
///
/// It intentionally does not reuse `BuildMeta`: qualification builds may deny
/// Exact replay while still needing a correctness-bound native Release base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeRelinkManifest {
    pub schema_version: u32,
    pub engine_contract: String,
    pub capability_class: String,
    pub canonical_fqbn: String,
    pub profile: String,
    pub build_signature: String,
    pub cli_version: String,
    pub toolchain_key: String,
    pub toolchain_identity_generation: u64,
    pub access_mode: String,
    pub authorization_key: String,
    pub project_name: String,
    pub canonical_project_dir: String,
    pub canonical_build_dir: String,
    pub build_options_sha256: String,
    pub recipe: NativeRelinkRecipeManifest,
    pub ccdb: NativeRelinkCcdbManifest,
    pub core_archive: NativeRelinkFileIdentity,
    pub core_cache_identity: NativeRelinkFileIdentity,
    pub dependency_content_signature: String,
    pub library_tree_signature: Option<u64>,
    pub library_roots: Vec<NativeRelinkLibraryRootManifest>,
    pub library_objects: Vec<NativeRelinkLibraryObjectManifest>,
    pub include_analysis: NativeRelinkIncludeManifest,
    pub translation_contract: String,
    pub last_source: NativeRelinkSourceManifest,
    pub sketch_object: NativeRelinkFileIdentity,
    pub sketch_depfile_sha256: String,
    pub outputs: NativeRelinkOutputManifest,
}

impl NativeRelinkManifest {
    pub(super) fn validate_header(&self) -> GateResult<()> {
        let core_only = self.library_roots.is_empty() && self.library_objects.is_empty();
        let bounded_libraries = !self.library_roots.is_empty()
            && self.library_roots.len() <= MAX_LIBRARY_ROOTS
            && self.library_objects.len() <= MAX_LIBRARY_OBJECTS;
        if self.schema_version != NATIVE_RELINK_MANIFEST_SCHEMA_VERSION
            || self.engine_contract != NATIVE_RELINK_ENGINE_CONTRACT
            || (core_only && self.capability_class != NATIVE_RELINK_CAPABILITY_CLASS)
            || (bounded_libraries
                && self.capability_class != NATIVE_RELINK_LIBRARY_CAPABILITY_CLASS)
            || (!core_only && !bounded_libraries)
            || self.profile != "release"
            || (core_only
                && !matches!(
                    self.translation_contract.as_str(),
                    DIRECT_CPP_TRANSLATION_CONTRACT
                        | DIRECT_CPP_IMPLICIT_ARDUINO_TRANSLATION_CONTRACT
                ))
            || (bounded_libraries
                && !matches!(
                    self.translation_contract.as_str(),
                    CK_MSTIMER2_AVR_TRANSLATION_CONTRACT | DIRECT_CPP_LIBRARY_TRANSLATION_CONTRACT
                ))
            || !self.canonical_fqbn.starts_with("arduino:avr:")
            || self.canonical_fqbn.matches(':').count() < 2
        {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                "manifest header does not name the AVR Release compile-only v2 contract",
            ));
        }
        for (label, value) in [
            ("build signature", self.build_signature.as_str()),
            ("CLI version", self.cli_version.as_str()),
            ("toolchain key", self.toolchain_key.as_str()),
            ("access mode", self.access_mode.as_str()),
            ("authorization key", self.authorization_key.as_str()),
            ("project name", self.project_name.as_str()),
            ("build options hash", self.build_options_sha256.as_str()),
            (
                "dependency signature",
                self.dependency_content_signature.as_str(),
            ),
        ] {
            if value.trim().is_empty() {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::InvalidManifest,
                    format!("manifest {label} is empty"),
                ));
            }
        }
        for (label, value) in [
            ("build options", self.build_options_sha256.as_str()),
            ("authorization key", self.authorization_key.as_str()),
            (
                "property contract",
                self.recipe.property_contract_sha256.as_str(),
            ),
            ("combine recipe", self.recipe.combine_sha256.as_str()),
            (
                "EEP objcopy recipe",
                self.recipe.objcopy_eep_sha256.as_str(),
            ),
            (
                "HEX objcopy recipe",
                self.recipe.objcopy_hex_sha256.as_str(),
            ),
            ("size recipe", self.recipe.size_sha256.as_str()),
            ("CCDB", self.ccdb.sha256.as_str()),
            (
                "CCDB command graph",
                self.ccdb.command_graph_sha256.as_str(),
            ),
            ("sketch command", self.ccdb.sketch_command_sha256.as_str()),
            ("sketch depfile", self.ccdb.sketch_depfile_sha256.as_str()),
            ("Core archive", self.core_archive.sha256.as_str()),
            (
                "Core cache identity",
                self.core_cache_identity.sha256.as_str(),
            ),
            ("last raw source", self.last_source.raw_sha256.as_str()),
            (
                "last normalized source",
                self.last_source.normalized_sha256.as_str(),
            ),
            ("sketch object", self.sketch_object.sha256.as_str()),
            (
                "committed sketch depfile",
                self.sketch_depfile_sha256.as_str(),
            ),
            ("EEP output", self.outputs.eep.sha256.as_str()),
        ] {
            if !is_sha256_hex(value) {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::InvalidManifest,
                    format!("manifest {label} is not a lowercase SHA-256"),
                ));
            }
        }
        lexical_absolute_path(Path::new(&self.canonical_project_dir))?;
        lexical_absolute_path(Path::new(&self.canonical_build_dir))?;
        if !safe_leaf_name(&self.project_name) || !self.project_name.ends_with(".ino") {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                "manifest project name is not a single .ino file name",
            ));
        }
        if !matches!(
            self.access_mode.as_str(),
            "qualification-probe" | "certified"
        ) || self.ccdb.schema != "release-ccdb-v2"
            || self.ccdb.size == 0
            || self.ccdb.entry_count < 2
            || self.ccdb.non_core_non_sketch_entry_count != self.library_objects.len()
            || self.recipe.archive_file.replace('\\', "/") != "core/core.a"
            || self.core_archive.relative_path.replace('\\', "/") != "core/core.a"
            || self.core_cache_identity.relative_path.replace('\\', "/")
                != CORE_CACHE_IDENTITY_RELATIVE_PATH
            || self.sketch_object.relative_path.replace('\\', "/")
                != self.ccdb.sketch_object_relative_path.replace('\\', "/")
            || !self.outputs.eep.relative_path.ends_with(".eep")
            || self
                .include_analysis
                .preprocessor_fingerprint
                .trim()
                .is_empty()
            || (core_only
                && (self.include_analysis.headers != ["arduino.h"]
                    || !self.include_analysis.synthesis_safe))
            || (bounded_libraries && self.include_analysis.headers.is_empty())
            || (core_only && self.library_tree_signature.is_some())
        {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                "manifest does not preserve the single-sketch AVR Release capability",
            ));
        }
        for (label, relative) in [
            (
                "CCDB sketch source",
                self.ccdb.sketch_source_relative_path.as_str(),
            ),
            (
                "CCDB sketch object",
                self.ccdb.sketch_object_relative_path.as_str(),
            ),
            ("Core archive", self.core_archive.relative_path.as_str()),
            (
                "Core cache identity",
                self.core_cache_identity.relative_path.as_str(),
            ),
            (
                "source backup",
                self.last_source.backup_relative_path.as_str(),
            ),
            ("sketch object", self.sketch_object.relative_path.as_str()),
            ("EEP output", self.outputs.eep.relative_path.as_str()),
        ] {
            if !safe_relative_path(relative) {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::InvalidManifest,
                    format!("manifest {label} path is not a safe relative path"),
                ));
            }
        }
        let mut root_paths = BTreeSet::new();
        let mut observed_object_counts = vec![0usize; self.library_roots.len()];
        for root in &self.library_roots {
            lexical_absolute_path(Path::new(&root.canonical_path))?;
            if !is_sha256_hex(&root.tree_sha256)
                || !root_paths.insert(path_key(Path::new(&root.canonical_path)))
            {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::InvalidManifest,
                    "library root identity is malformed or duplicated",
                ));
            }
        }
        let mut library_object_paths = BTreeSet::new();
        for object in &self.library_objects {
            if object.library_root_index >= self.library_roots.len()
                || !safe_relative_path(&object.source_relative_path)
                || !safe_relative_path(&object.object.relative_path)
                || !safe_relative_path(&object.depfile.relative_path)
                || !object
                    .object
                    .relative_path
                    .replace('\\', "/")
                    .starts_with("libraries/")
                || !object
                    .depfile
                    .relative_path
                    .replace('\\', "/")
                    .starts_with("libraries/")
                || object.object.size == 0
                || object.depfile.size == 0
                || !is_sha256_hex(&object.object.sha256)
                || !is_sha256_hex(&object.depfile.sha256)
                || !is_sha256_hex(&object.command_sha256)
                || !library_object_paths.insert(object.object.relative_path.replace('\\', "/"))
            {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::InvalidManifest,
                    "library object identity is malformed, unsafe, or duplicated",
                ));
            }
            observed_object_counts[object.library_root_index] += 1;
        }
        if self
            .library_roots
            .iter()
            .zip(observed_object_counts)
            .any(|(root, observed)| root.object_count != observed)
        {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                "library root object counts do not match the ordered object graph",
            ));
        }
        if self.core_archive.size == 0
            || self.core_cache_identity.size == 0
            || self.sketch_object.size == 0
            || self.outputs.eep.size == 0
            || self.outputs.artifacts.is_empty()
        {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                "manifest contains an empty required file identity",
            ));
        }
        let mut artifact_paths = BTreeSet::new();
        for artifact in &self.outputs.artifacts {
            if artifact.size == 0
                || !is_sha256_hex(&artifact.sha256)
                || !safe_relative_path(&artifact.relative_path)
                || !artifact_paths.insert(artifact.relative_path.replace('\\', "/"))
            {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::InvalidManifest,
                    "manifest artifact identities are empty, unsafe, or duplicated",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeCompileCommand {
    #[serde(default)]
    pub directory: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    #[serde(default)]
    pub command: String,
    pub file: String,
    #[serde(default)]
    pub output: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NativeReleaseCcdbContract {
    pub entries: Vec<NativeCompileCommand>,
    pub command_graph_sha256: String,
    pub core_command_graph_sha256: String,
    pub sketch_entry_index: usize,
    pub sketch_source: PathBuf,
    pub sketch_object: PathBuf,
    pub sketch_command_sha256: String,
    pub core_entry_count: usize,
    pub core_objects: Vec<NativeReleaseCoreObjectContract>,
    pub library_objects: Vec<NativeReleaseLibraryObjectContract>,
}

/// One Core or variant translation unit emitted by Arduino CLI's native
/// Release build. ReleaseCoreSeed consumes this only after the surrounding
/// CCDB contract has passed the existing executable/source/output gates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NativeReleaseCoreObjectContract {
    pub working_directory: PathBuf,
    pub compiler_executable: PathBuf,
    pub source: PathBuf,
    pub object: PathBuf,
    pub depfile: PathBuf,
    pub command_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NativeReleaseLibraryObjectContract {
    pub library_root_index: usize,
    pub library_root: PathBuf,
    pub working_directory: PathBuf,
    pub source: PathBuf,
    pub object: PathBuf,
    pub depfile: PathBuf,
    pub command_sha256: String,
}

/// Read-only compiler evidence used to prove that a declared, transitive
/// Arduino dependency really contributes a file to a compiled translation
/// unit. Only the exact sketch row and selected library-object rows from the
/// authenticated CCDB are admissible; Core rows are never graph authority.
#[derive(Debug, Clone)]
pub(super) struct NativeRelinkLibraryDepfileUseInput {
    pub source: PathBuf,
    pub object: PathBuf,
    pub depfile: PathBuf,
    pub working_directory: PathBuf,
    pub source_is_sketch: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NativeReleaseRecipeContract {
    pub combine_tokens: Vec<String>,
    pub objcopy_eep_tokens: Vec<String>,
    pub objcopy_hex_tokens: Vec<String>,
    pub size_tokens: Vec<String>,
    pub manifest: NativeRelinkRecipeManifest,
}

pub(super) struct NativeReleaseRecipeInput<'a> {
    pub property_contract_sha256: &'a str,
    pub combine: &'a str,
    pub objcopy_eep: &'a str,
    pub objcopy_hex: &'a str,
    pub size: &'a str,
    pub build_dir: &'a Path,
    pub project_elf: &'a Path,
    pub project_eep: &'a Path,
    pub project_hex: &'a Path,
    pub core_archive: &'a Path,
    pub sketch_object: &'a Path,
    pub library_objects: &'a [PathBuf],
    pub allowed_tool_roots: &'a [PathBuf],
    pub sketch_compile_tokens: &'a [String],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DirectCppTranslationContract {
    pub contract: &'static str,
    pub source_sha256: String,
    pub function_names: Vec<String>,
}

#[derive(Clone)]
pub(super) struct NativeRelinkBaselineInput<'a> {
    pub canonical_fqbn: &'a str,
    pub build_signature: &'a str,
    pub cli_version: &'a str,
    pub toolchain_key: &'a str,
    pub toolchain_identity_generation: u64,
    pub access_mode: &'a str,
    pub authorization_key: &'a str,
    pub project_name: &'a str,
    pub project_dir: &'a Path,
    pub build_dir: &'a Path,
    pub sketch_ino: &'a Path,
    pub build_options: &'a Path,
    pub ccdb: &'a Path,
    pub core_archive: &'a Path,
    pub property_contract_sha256: &'a str,
    pub combine_recipe: &'a str,
    pub objcopy_eep_recipe: &'a str,
    pub objcopy_hex_recipe: &'a str,
    pub size_recipe: &'a str,
    pub allowed_working_roots: &'a [PathBuf],
    pub allowed_source_roots: &'a [PathBuf],
    pub allowed_library_roots: &'a [PathBuf],
    pub allowed_tool_roots: &'a [PathBuf],
    pub dependency_content_signature: &'a str,
    pub library_tree_signature: Option<u64>,
    pub include_analysis: NativeRelinkIncludeManifest,
    pub source: &'a str,
    pub normalized_source: &'a str,
    pub backup_relative_path: &'a str,
    pub artifact_paths: &'a [PathBuf],
    pub eep_path: &'a Path,
    pub size_summary: &'a [String],
}

#[derive(Debug)]
pub(super) struct CapturedNativeRelinkBaseline {
    pub manifest: NativeRelinkManifest,
    pub ccdb_contract: NativeReleaseCcdbContract,
    pub recipe_contract: NativeReleaseRecipeContract,
}

const NATIVE_RELINK_CCDB_MAX_BYTES: u64 = 16 * 1024 * 1024;

pub(super) fn sha256_file(path: &Path) -> GateResult<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::MissingFile,
            format!("cannot open {}: {error}", path.display()),
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                format!("cannot hash {}: {error}", path.display()),
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn bounded_library_files(root: &Path) -> GateResult<(PathBuf, Vec<PathBuf>)> {
    fn visit(
        root: &Path,
        directory: &Path,
        files: &mut Vec<PathBuf>,
        depth: usize,
    ) -> GateResult<()> {
        if depth > 32 {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                "library tree exceeds the bounded directory depth",
            ));
        }
        let entries = std::fs::read_dir(directory).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::MissingFile,
                format!(
                    "cannot enumerate library directory {}: {error}",
                    directory.display()
                ),
            )
        })?;
        let mut entries = entries
            .map(|entry| {
                entry.map_err(|error| {
                    NativeRelinkGateError::new(
                        NativeRelinkGateCode::MissingFile,
                        format!(
                            "cannot enumerate one library entry below {}: {error}",
                            directory.display()
                        ),
                    )
                })
            })
            .collect::<GateResult<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
        for entry in entries {
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
                NativeRelinkGateError::new(
                    NativeRelinkGateCode::MissingFile,
                    format!("cannot inspect library entry {}: {error}", path.display()),
                )
            })?;
            if metadata_is_reparse(&metadata) {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::UnsafeFilesystemEntry,
                    format!(
                        "library tree contains a reparse/symlink entry: {}",
                        path.display()
                    ),
                ));
            }
            if metadata.is_dir() {
                visit(root, &path, files, depth + 1)?;
            } else if metadata.is_file() {
                let relative = path.strip_prefix(root).map_err(|_| {
                    NativeRelinkGateError::new(
                        NativeRelinkGateCode::InvalidPath,
                        "library file escaped its canonical root",
                    )
                })?;
                if !safe_relative_path(&relative.to_string_lossy()) {
                    return Err(NativeRelinkGateError::new(
                        NativeRelinkGateCode::InvalidPath,
                        format!(
                            "library file has an unsafe relative path: {}",
                            path.display()
                        ),
                    ));
                }
                files.push(path);
                if files.len() > MAX_LIBRARY_TREE_FILES {
                    return Err(NativeRelinkGateError::new(
                        NativeRelinkGateCode::InvalidManifest,
                        "library tree exceeds the bounded file count",
                    ));
                }
            } else {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::UnsafeFilesystemEntry,
                    format!("library tree contains a non-file entry: {}", path.display()),
                ));
            }
        }
        Ok(())
    }

    let canonical = canonical_directory(root)?;
    let mut files = Vec::new();
    visit(&canonical, &canonical, &mut files, 0)?;
    files.sort_by_key(|path| {
        path.strip_prefix(&canonical)
            .map(path_key)
            .unwrap_or_default()
    });
    Ok((canonical, files))
}

fn hash_bounded_library_tree(root: &Path) -> GateResult<String> {
    let (canonical, files) = bounded_library_files(root)?;
    let mut total_bytes = 0u64;
    let mut hasher = Sha256::new();
    hasher.update(b"ck-native-relink-library-tree-v1\0");
    for path in files {
        let relative = path
            .strip_prefix(&canonical)
            .expect("visited library files stay below the canonical root");
        let relative = path_key(relative);
        let metadata = std::fs::metadata(&path).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::MissingFile,
                format!("cannot inspect library file {}: {error}", path.display()),
            )
        })?;
        total_bytes = total_bytes.checked_add(metadata.len()).ok_or_else(|| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                "library tree byte count overflowed",
            )
        })?;
        if total_bytes > MAX_LIBRARY_TREE_BYTES {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                "library tree exceeds the bounded byte count",
            ));
        }
        hasher.update((relative.len() as u64).to_le_bytes());
        hasher.update(relative.as_bytes());
        hasher.update(metadata.len().to_le_bytes());
        let bytes = std::fs::read(&path).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::MissingFile,
                format!("cannot read library file {}: {error}", path.display()),
            )
        })?;
        hasher.update(bytes);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn bounded_library_public_paths(root: &Path) -> GateResult<BTreeSet<String>> {
    let (canonical, files) = bounded_library_files(root)?;
    let mut public_paths = BTreeSet::new();
    for path in files {
        let relative = path
            .strip_prefix(&canonical)
            .expect("bounded library files stay below the canonical root");
        let relative = relative
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        public_paths.insert(relative.clone());
        if let Some(from_src) = relative.strip_prefix("src/") {
            public_paths.insert(from_src.to_string());
        }
    }
    Ok(public_paths)
}

fn canonical_ordinary_file(path: &Path, label: &str) -> GateResult<PathBuf> {
    let parent = path.parent().ok_or_else(|| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            format!("{label} has no parent directory"),
        )
    })?;
    canonical_regular_file_within(path, &[parent.to_path_buf()]).map_err(|error| {
        NativeRelinkGateError::new(error.code, format!("{label} is unsafe: {}", error.detail))
    })
}

/// Return the exact Arduino library leaf that owns a canonical dependency.
/// A broad `libraries/` or `ck_shim_libs/` search directory is never a leaf:
/// ownership requires either an ordinary library manifest in the leaf or the
/// conventional direct-child layout below one of those search roots.
fn canonical_arduino_library_leaf_for_file(path: &Path) -> GateResult<Option<PathBuf>> {
    let mut cursor = path.parent();
    while let Some(directory) = cursor {
        for manifest in ["library.properties", "library.json"] {
            let candidate = directory.join(manifest);
            match std::fs::symlink_metadata(&candidate) {
                Ok(metadata) => {
                    if metadata_is_reparse(&metadata) || !metadata.is_file() {
                        return Err(NativeRelinkGateError::new(
                            NativeRelinkGateCode::UnsafeFilesystemEntry,
                            format!(
                                "Arduino library manifest is not an ordinary file: {}",
                                candidate.display()
                            ),
                        ));
                    }
                    return canonical_directory(directory).map(Some);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(NativeRelinkGateError::new(
                        NativeRelinkGateCode::InvalidPath,
                        format!(
                            "cannot inspect Arduino library manifest {}: {error}",
                            candidate.display()
                        ),
                    ));
                }
            }
        }
        if directory.parent().is_some_and(|parent| {
            parent
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.eq_ignore_ascii_case("libraries")
                        || name.eq_ignore_ascii_case("ck_shim_libs")
                })
        }) {
            return canonical_directory(directory).map(Some);
        }
        cursor = directory.parent();
    }
    Ok(None)
}

/// Prove the only additional roots that may be admitted beyond a sketch's
/// direct header providers and compiled library objects: uniquely declared,
/// genuinely header-only Arduino dependencies whose ordinary file was read by
/// the exact sketch or an authenticated selected-library compilation. This
/// intentionally permits valid Arduino include fragments such as `.inc`,
/// `.ipp`, `.tpp`, and extensionless files; canonical leaf-root containment,
/// not a filename suffix, is the security boundary.
///
/// `roots` is the already bounded candidate graph, never a sketchbook or
/// platform search directory.  A `depends=` edge can select exactly one root;
/// an absent/ambiguous provider, missing/malformed depfile, unsafe path, source
/// mismatch, non-header-only missing object, or root-count overflow all fail
/// closed.
pub(super) fn validate_declared_header_only_library_usage(
    roots: &[PathBuf],
    initially_used: &BTreeSet<usize>,
    depfiles: &[NativeRelinkLibraryDepfileUseInput],
    allowed_dependency_roots: Option<&[PathBuf]>,
) -> GateResult<BTreeSet<usize>> {
    let library_roots = canonical_library_roots(roots)?
        .into_iter()
        .map(|(root, _)| root)
        .collect::<Vec<_>>();
    if initially_used
        .iter()
        .any(|index| *index >= library_roots.len())
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "initial library-use proof contains an out-of-range root index",
        ));
    }

    let properties = library_roots
        .iter()
        .map(|root| read_graph_transition_library_properties(root))
        .collect::<GateResult<Vec<_>>>()?;
    let identities = library_roots
        .iter()
        .zip(&properties)
        .map(|(root, properties)| {
            let mut keys = BTreeSet::new();
            if let Some(folder) = root.file_name().and_then(|value| value.to_str()) {
                keys.insert(graph_library_name_key(folder));
            }
            if let Some(name) = properties
                .as_deref()
                .and_then(|text| graph_library_property(text, "name"))
            {
                keys.insert(graph_library_name_key(name));
            }
            keys
        })
        .collect::<Vec<_>>();
    let canonical_dependency_roots = allowed_dependency_roots.map(canonical_roots).transpose()?;

    let mut referenced_header_only_roots = BTreeSet::new();
    let mut sketch_evidence_count = 0usize;
    for evidence in depfiles {
        let object = canonical_ordinary_file(&evidence.object, "library object")?;
        let depfile = canonical_ordinary_file(&evidence.depfile, "library depfile")?;
        let source = canonical_ordinary_file(&evidence.source, "library source")?;
        let owners = library_roots
            .iter()
            .enumerate()
            .filter_map(|(index, root)| source.starts_with(root).then_some(index))
            .collect::<Vec<_>>();
        if evidence.source_is_sketch {
            sketch_evidence_count += 1;
            if sketch_evidence_count > 1 || !owners.is_empty() {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::CcdbAmbiguous,
                    "sketch depfile evidence is duplicated or owned by a library root",
                ));
            }
        } else if owners.len() != 1 || !initially_used.contains(&owners[0]) {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbAmbiguous,
                "library depfile source is not owned by exactly one already-used root",
            ));
        }
        let metadata = std::fs::metadata(&depfile).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::MissingFile,
                format!("cannot inspect library depfile: {error}"),
            )
        })?;
        if metadata.len() == 0 || metadata.len() > NATIVE_RELINK_CCDB_MAX_BYTES {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbUnsupportedEntry,
                "library depfile is empty or exceeds the bounded size",
            ));
        }
        let raw = std::fs::read_to_string(&depfile).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbUnsupportedEntry,
                format!("cannot read library depfile as UTF-8: {error}"),
            )
        })?;
        let (targets, dependencies) = parse_single_rule_depfile(&raw)?;
        if targets.len() != 1
            || path_key(&resolve_token_path(
                &targets[0].decoded,
                &evidence.working_directory,
            )) != path_key(&object)
        {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbAmbiguous,
                "library depfile target does not bind its exact object",
            ));
        }

        let source_key = path_key(&source);
        let mut source_count = 0usize;
        let mut dependency_keys = BTreeSet::new();
        for dependency in dependencies {
            let resolved = resolve_token_path(&dependency.decoded, &evidence.working_directory);
            let canonical = canonical_ordinary_file(&resolved, "library dependency")?;
            if canonical_dependency_roots
                .as_ref()
                .is_some_and(|roots| !roots.iter().any(|root| canonical.starts_with(root)))
            {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::ToolOutsideManagedRoot,
                    format!(
                        "translation-unit depfile escaped every managed dependency root: {}",
                        canonical.display()
                    ),
                ));
            }
            let key = path_key(&canonical);
            if !dependency_keys.insert(key.clone()) {
                if key == source_key {
                    return Err(NativeRelinkGateError::new(
                        NativeRelinkGateCode::CcdbAmbiguous,
                        "library depfile repeats its CCDB source",
                    ));
                }
                continue;
            }
            if key == source_key {
                source_count += 1;
            }
            if let Some(library_leaf) = canonical_arduino_library_leaf_for_file(&canonical)? {
                let providers = library_roots
                    .iter()
                    .enumerate()
                    .filter_map(|(index, root)| {
                        (path_key(root) == path_key(&library_leaf)).then_some(index)
                    })
                    .collect::<Vec<_>>();
                if providers.len() != 1 {
                    return Err(NativeRelinkGateError::new(
                        NativeRelinkGateCode::CcdbAmbiguous,
                        format!(
                            "compiler dependency belongs to an unselected or ambiguous Arduino library leaf: {}",
                            library_leaf.display()
                        ),
                    ));
                }
                referenced_header_only_roots.insert(providers[0]);
            }
        }
        if source_count != 1 {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbAmbiguous,
                format!(
                    "library depfile must bind its source exactly once (observed {source_count})"
                ),
            ));
        }
    }

    let mut used = initially_used.clone();
    let mut queue = initially_used.iter().copied().collect::<Vec<_>>();
    let mut cursor = 0usize;
    while cursor < queue.len() {
        let owner = queue[cursor];
        cursor += 1;
        let Some(properties) = properties[owner].as_deref() else {
            continue;
        };
        for dependency in graph_library_dependencies(properties) {
            let providers = identities
                .iter()
                .enumerate()
                .filter_map(|(index, keys)| keys.contains(&dependency).then_some(index))
                .collect::<Vec<_>>();
            if providers.len() != 1 {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::CcdbAmbiguous,
                    format!(
                        "declared library dependency has {} selected providers",
                        providers.len()
                    ),
                ));
            }
            let provider = providers[0];
            if used.contains(&provider) {
                continue;
            }
            if !graph_transition_library_sources(&library_roots[provider])?.is_empty() {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::CcdbAmbiguous,
                    "declared library dependency has translation units but no authenticated object",
                ));
            }
            if !referenced_header_only_roots.contains(&provider) {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::InvalidManifest,
                    format!(
                        "declared header-only dependency has no sealed sketch/library depfile reference: {}",
                        library_roots[provider].display()
                    ),
                ));
            }
            used.insert(provider);
            queue.push(provider);
        }
    }
    Ok(used)
}

fn validate_library_header_root_bindings(
    include_analysis: &NativeRelinkIncludeManifest,
    captured_roots: &[(PathBuf, NativeRelinkLibraryRootManifest)],
    depfiles: &[NativeRelinkLibraryDepfileUseInput],
    allowed_dependency_roots: &[PathBuf],
) -> GateResult<()> {
    let public_paths = captured_roots
        .iter()
        .map(|(root, _)| bounded_library_public_paths(root))
        .collect::<GateResult<Vec<_>>>()?;
    let mut initially_used = captured_roots
        .iter()
        .enumerate()
        .filter_map(|(index, (_, manifest))| (manifest.object_count > 0).then_some(index))
        .collect::<BTreeSet<_>>();
    for header in &include_analysis.headers {
        let header = header.replace('\\', "/").to_ascii_lowercase();
        if header == "arduino.h" {
            continue;
        }
        let providers = public_paths
            .iter()
            .enumerate()
            .filter_map(|(index, paths)| paths.contains(&header).then_some(index))
            .collect::<Vec<_>>();
        if providers.len() != 1 {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                format!(
                    "included library header must have exactly one admitted root: {header} (observed {})",
                    providers.len()
                ),
            ));
        }
        initially_used.insert(providers[0]);
    }
    let roots = captured_roots
        .iter()
        .map(|(root, _)| root.clone())
        .collect::<Vec<_>>();
    let used = validate_declared_header_only_library_usage(
        &roots,
        &initially_used,
        depfiles,
        Some(allowed_dependency_roots),
    )?;
    if let Some(index) = (0..captured_roots.len()).find(|index| !used.contains(index)) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            format!(
                "admitted library root is unused by the sealed include/object graph: {}",
                captured_roots[index].0.display()
            ),
        ));
    }
    Ok(())
}

fn canonical_library_roots(
    roots: &[PathBuf],
) -> GateResult<Vec<(PathBuf, NativeRelinkLibraryRootManifest)>> {
    if roots.len() > MAX_LIBRARY_ROOTS {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "too many explicitly admitted library roots",
        ));
    }
    let mut seen = BTreeSet::new();
    let mut captured: Vec<(PathBuf, NativeRelinkLibraryRootManifest)> =
        Vec::with_capacity(roots.len());
    for root in roots {
        let canonical = canonical_directory(root)?;
        if !seen.insert(path_key(&canonical)) {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                "explicit library roots contain an alias or duplicate",
            ));
        }
        if captured.iter().any(|(existing, _)| {
            canonical.starts_with(existing) || existing.starts_with(&canonical)
        }) {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                "explicit library roots overlap as ancestor and descendant",
            ));
        }
        captured.push((
            canonical.clone(),
            NativeRelinkLibraryRootManifest {
                canonical_path: canonical.to_string_lossy().into_owned(),
                tree_sha256: hash_bounded_library_tree(&canonical)?,
                object_count: 0,
            },
        ));
    }
    Ok(captured)
}

fn capture_library_object_manifest(
    contract: &NativeReleaseLibraryObjectContract,
    build: &Path,
    allowed_dependency_roots: &[PathBuf],
) -> GateResult<NativeRelinkLibraryObjectManifest> {
    let object = file_identity_within(&contract.object, build)?;
    let depfile = file_identity_within(&contract.depfile, build)?;
    if depfile.size > NATIVE_RELINK_CCDB_MAX_BYTES {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbUnsupportedEntry,
            "library depfile exceeds the bounded size",
        ));
    }
    let raw = std::fs::read_to_string(&contract.depfile).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbUnsupportedEntry,
            format!("cannot read library depfile as UTF-8: {error}"),
        )
    })?;
    let (targets, dependencies) = parse_single_rule_depfile(&raw)?;
    if targets.len() != 1
        || path_key(&resolve_token_path(
            &targets[0].decoded,
            &contract.working_directory,
        )) != path_key(&contract.object)
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbAmbiguous,
            "library depfile target does not name its exact CCDB object",
        ));
    }
    let canonical_dependency_roots = canonical_roots(allowed_dependency_roots)?;
    let mut dependency_keys = BTreeSet::new();
    let mut source_count = 0usize;
    let source_key = path_key(&contract.source);
    for dependency in dependencies {
        let resolved = resolve_token_path(&dependency.decoded, &contract.working_directory);
        let canonical = canonical_regular_file_within(&resolved, &canonical_dependency_roots)?;
        let key = path_key(&canonical);
        if !dependency_keys.insert(key.clone()) {
            // GCC may emit the same canonical dependency more than once when
            // include aliases converge on one file. Each token has already
            // passed canonical-path and admitted-root validation above, so a
            // duplicate adds no authority and is safe to collapse as a set.
            if key == source_key {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::CcdbAmbiguous,
                    "library depfile repeats its CCDB source",
                ));
            }
            continue;
        }
        if key == source_key {
            source_count += 1;
        }
    }
    if source_count != 1 {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbAmbiguous,
            format!(
                "library depfile must bind its CCDB source exactly once (observed {source_count})"
            ),
        ));
    }
    let source_relative = contract
        .source
        .strip_prefix(&contract.library_root)
        .map_err(|_| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                "library CCDB source escaped its admitted root",
            )
        })?;
    let source_relative = source_relative.to_string_lossy().replace('\\', "/");
    if !safe_relative_path(&source_relative) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            "library CCDB source has an unsafe relative path",
        ));
    }
    Ok(NativeRelinkLibraryObjectManifest {
        library_root_index: contract.library_root_index,
        source_relative_path: source_relative,
        object,
        depfile,
        command_sha256: contract.command_sha256.clone(),
    })
}

fn validate_library_manifest_bindings(
    manifest: &NativeRelinkManifest,
    build: &Path,
) -> GateResult<()> {
    let mut object_counts = vec![0usize; manifest.library_roots.len()];
    for root in &manifest.library_roots {
        let canonical = canonical_directory(Path::new(&root.canonical_path))?;
        if path_key(&canonical) != path_key(Path::new(&root.canonical_path))
            || hash_bounded_library_tree(&canonical)? != root.tree_sha256
        {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!("library root changed: {}", root.canonical_path),
            ));
        }
    }
    for object in &manifest.library_objects {
        if object.library_root_index >= manifest.library_roots.len() {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                "library object references an absent root",
            ));
        }
        validate_file_binding(build, &object.object, "Library object")?;
        validate_file_binding(build, &object.depfile, "Library depfile")?;
        object_counts[object.library_root_index] += 1;
    }
    if manifest
        .library_roots
        .iter()
        .zip(object_counts)
        .any(|(root, observed)| root.object_count != observed)
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "library object cardinality changed",
        ));
    }
    Ok(())
}

fn file_identity_within(path: &Path, root: &Path) -> GateResult<NativeRelinkFileIdentity> {
    let canonical = canonical_regular_file_within(path, &[root.to_path_buf()])?;
    let canonical_root = canonical_directory(root)?;
    let relative = canonical.strip_prefix(&canonical_root).map_err(|_| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            format!("file escaped identity root: {}", path.display()),
        )
    })?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    if !safe_relative_path(&relative) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            format!("file identity has unsafe relative path: {relative}"),
        ));
    }
    let size = std::fs::metadata(&canonical)
        .map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::MissingFile,
                format!("cannot inspect {}: {error}", canonical.display()),
            )
        })?
        .len();
    if size == 0 {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::EmptyFile,
            format!("required file is empty: {}", canonical.display()),
        ));
    }
    Ok(NativeRelinkFileIdentity {
        relative_path: relative,
        size,
        sha256: sha256_file(&canonical)?,
    })
}

/// Capture independent build-file identities concurrently while preserving
/// the caller's path order.  This is only a scheduling optimization: every
/// worker still performs the same canonical-path, regular-file, size and
/// complete SHA-256 checks as the serial implementation.  A worker panic is
/// treated as a dirty build rather than allowing a partial identity set to
/// reach a manifest.
fn parallel_file_identities(
    paths: &[&Path],
    root: &Path,
) -> GateResult<Vec<NativeRelinkFileIdentity>> {
    // Keep the optimization bounded even if a malformed compiler response
    // advertises an unexpectedly large artifact set.  The serial fallback
    // retains the exact same fail-closed checks without creating unbounded
    // native threads.
    if paths.len() > MAX_PARALLEL_IDENTITY_WORKERS {
        return paths
            .iter()
            .map(|path| file_identity_within(path, root))
            .collect();
    }
    let results = std::thread::scope(|scope| {
        let handles = paths
            .iter()
            .map(|path| {
                let path = *path;
                let root = root;
                scope.spawn(move || file_identity_within(path, root))
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| {
                handle.join().map_err(|_| {
                    NativeRelinkGateError::new(
                        NativeRelinkGateCode::DirtyBuild,
                        "parallel NativeRelink identity worker panicked",
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()
    })?;
    results.into_iter().collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeRelinkContentIdentity {
    size: u64,
    sha256: String,
}

fn content_identity_within(path: &Path, root: &Path) -> GateResult<NativeRelinkContentIdentity> {
    let identity = file_identity_within(path, root)?;
    Ok(NativeRelinkContentIdentity {
        size: identity.size,
        sha256: identity.sha256,
    })
}

fn validate_content_bindings(
    paths: &[&Path],
    root: &Path,
    expected: &[NativeRelinkContentIdentity],
) -> GateResult<()> {
    if paths.len() != expected.len() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "transaction content binding cardinality changed",
        ));
    }
    for (path, expected) in paths.iter().zip(expected) {
        let actual = content_identity_within(path, root)?;
        if &actual != expected {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!(
                    "committed output changed outside the transaction: {}",
                    path.display()
                ),
            ));
        }
    }
    Ok(())
}

fn validate_manifest_transition(
    previous: &NativeRelinkManifest,
    next: &NativeRelinkManifest,
) -> GateResult<()> {
    let mut expected = previous.clone();
    // This counter is a request-local mutation fence, not durable Core or
    // toolchain identity.  It may legitimately differ after an application
    // restart or a package-cache invalidation that resolves to the exact same
    // strong content key.  The active lease is revalidated immediately before
    // commit, while `toolchain_key` and every manifest-bound SHA remain part of
    // this equality check.
    expected.toolchain_identity_generation = next.toolchain_identity_generation;
    expected.dependency_content_signature = next.dependency_content_signature.clone();
    expected.ccdb.sketch_depfile_sha256 = next.ccdb.sketch_depfile_sha256.clone();
    expected.last_source = next.last_source.clone();
    expected.sketch_object = next.sketch_object.clone();
    expected.sketch_depfile_sha256 = next.sketch_depfile_sha256.clone();
    expected.outputs = next.outputs.clone();
    if expected != *next {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "immutable Release identity changed during NativeRelink transaction",
        ));
    }
    Ok(())
}

/// Capture a complete native Release baseline after Arduino CLI succeeds.
///
/// This function only reads and authenticates files. It does not write a
/// manifest and never executes a tool.
pub(super) fn capture_native_relink_baseline(
    input: NativeRelinkBaselineInput<'_>,
) -> GateResult<CapturedNativeRelinkBaseline> {
    if !input.canonical_fqbn.starts_with("arduino:avr:")
        || input.build_signature.trim().is_empty()
        || input.cli_version.trim().is_empty()
        || input.toolchain_key.trim().is_empty()
        || input.dependency_content_signature.trim().is_empty()
        || !matches!(input.access_mode, "qualification-probe" | "certified")
        || !is_sha256_hex(input.authorization_key)
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "baseline identity is incomplete or not an Arduino AVR target",
        ));
    }
    let library_mode = !input.allowed_library_roots.is_empty();
    if input
        .include_analysis
        .preprocessor_fingerprint
        .trim()
        .is_empty()
        || (!library_mode
            && (input.include_analysis.headers != ["arduino.h"]
                || !input.include_analysis.synthesis_safe))
        || (library_mode && input.include_analysis.headers.is_empty())
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::TranslationUnsupported,
            "baseline include/preprocessor contract is not an admitted NativeRelink subset",
        ));
    }
    let translation_plan =
        validate_native_relink_translation(input.source, &input.include_analysis, library_mode)?;
    let translation_contract = translation_plan.contract;
    if !safe_relative_path(input.backup_relative_path) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            "baseline backup path is not a safe relative path",
        ));
    }

    let project = canonical_directory(input.project_dir)?;
    let build = canonical_directory(input.build_dir)?;
    let sketch_ino = canonical_regular_file_within(input.sketch_ino, &[project.clone()])?;
    if sketch_ino.file_name().and_then(|value| value.to_str()) != Some(input.project_name)
        || std::fs::read(&sketch_ino).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::MissingFile,
                format!("cannot read root sketch: {error}"),
            )
        })? != input.source.as_bytes()
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "root sketch name/bytes differ from the requested baseline source",
        ));
    }

    let build_options = file_identity_within(input.build_options, &build)?;
    let ccdb_identity = file_identity_within(input.ccdb, &build)?;
    if ccdb_identity.size > NATIVE_RELINK_CCDB_MAX_BYTES {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbUnsupportedEntry,
            "Release CCDB exceeds the bounded Phase 1 size",
        ));
    }
    let ccdb_raw = std::fs::read_to_string(input.ccdb).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbUnsupportedEntry,
            format!("cannot read Release CCDB as UTF-8: {error}"),
        )
    })?;
    let ccdb_entries: Vec<NativeCompileCommand> =
        serde_json::from_str(&ccdb_raw).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbUnsupportedEntry,
                format!("cannot parse Release CCDB: {error}"),
            )
        })?;
    let ccdb_contract = validate_release_ccdb_contract(
        &ccdb_entries,
        &build,
        input.allowed_working_roots,
        input.allowed_source_roots,
        input.allowed_library_roots,
        input.allowed_tool_roots,
    )?;
    let mut captured_library_roots = canonical_library_roots(input.allowed_library_roots)?;
    let mut allowed_dependency_roots = input.allowed_source_roots.to_vec();
    allowed_dependency_roots.extend_from_slice(input.allowed_library_roots);
    allowed_dependency_roots.extend_from_slice(input.allowed_tool_roots);
    let mut library_objects = Vec::with_capacity(ccdb_contract.library_objects.len());
    for object in &ccdb_contract.library_objects {
        let manifest = capture_library_object_manifest(object, &build, &allowed_dependency_roots)?;
        captured_library_roots[manifest.library_root_index]
            .1
            .object_count += 1;
        library_objects.push(manifest);
    }
    // A root is admissible only when it contributes a sealed translation unit
    // or uniquely exposes one of the sketch's literal includes.  This keeps
    // header-only Arduino libraries (for example EEPROM) usable without
    // turning a broad sketchbook/platform directory into an ambient source
    // execution boundary.
    let mut library_depfile_evidence = vec![NativeRelinkLibraryDepfileUseInput {
        source: ccdb_contract.sketch_source.clone(),
        object: ccdb_contract.sketch_object.clone(),
        depfile: ccdb_contract.sketch_object.with_extension("d"),
        working_directory: PathBuf::from(
            ccdb_contract.entries[ccdb_contract.sketch_entry_index]
                .directory
                .trim(),
        ),
        source_is_sketch: true,
    }];
    library_depfile_evidence.extend(ccdb_contract.library_objects.iter().map(|object| {
        NativeRelinkLibraryDepfileUseInput {
            source: object.source.clone(),
            object: object.object.clone(),
            depfile: object.depfile.clone(),
            working_directory: object.working_directory.clone(),
            source_is_sketch: false,
        }
    }));
    validate_library_header_root_bindings(
        &input.include_analysis,
        &captured_library_roots,
        &library_depfile_evidence,
        &allowed_dependency_roots,
    )?;
    let library_roots = captured_library_roots
        .into_iter()
        .map(|(_, manifest)| manifest)
        .collect::<Vec<_>>();
    let sketch_entry = &ccdb_contract.entries[ccdb_contract.sketch_entry_index];
    let sketch_tokens = command_tokens(sketch_entry)?;
    let recipe_contract = validate_release_recipe_contract(NativeReleaseRecipeInput {
        property_contract_sha256: input.property_contract_sha256,
        combine: input.combine_recipe,
        objcopy_eep: input.objcopy_eep_recipe,
        objcopy_hex: input.objcopy_hex_recipe,
        size: input.size_recipe,
        build_dir: &build,
        project_elf: &build.join(format!("{}.elf", input.project_name)),
        project_eep: input.eep_path,
        project_hex: &build.join(format!("{}.hex", input.project_name)),
        core_archive: input.core_archive,
        sketch_object: &ccdb_contract.sketch_object,
        library_objects: &ccdb_contract
            .library_objects
            .iter()
            .map(|object| object.object.clone())
            .collect::<Vec<_>>(),
        allowed_tool_roots: input.allowed_tool_roots,
        sketch_compile_tokens: &sketch_tokens,
    })?;

    let sketch_depfile_path = ccdb_contract.sketch_object.with_extension("d");
    let core_cache_path = build.join(CORE_CACHE_IDENTITY_RELATIVE_PATH);
    let fixed_identity_paths: [&Path; 5] = [
        input.core_archive,
        core_cache_path.as_path(),
        ccdb_contract.sketch_object.as_path(),
        sketch_depfile_path.as_path(),
        input.eep_path,
    ];
    let mut fixed_identities = parallel_file_identities(&fixed_identity_paths, &build)?.into_iter();
    let core_archive = fixed_identities
        .next()
        .expect("fixed NativeRelink identity count is five");
    let core_cache_identity = fixed_identities
        .next()
        .expect("fixed NativeRelink identity count is five");
    let sketch_object = fixed_identities
        .next()
        .expect("fixed NativeRelink identity count is five");
    let sketch_depfile = fixed_identities
        .next()
        .expect("fixed NativeRelink identity count is five");
    let eep = fixed_identities
        .next()
        .expect("fixed NativeRelink identity count is five");
    let artifact_paths_input = input
        .artifact_paths
        .iter()
        .map(PathBuf::as_path)
        .collect::<Vec<_>>();
    let artifact_identities = parallel_file_identities(&artifact_paths_input, &build)?;
    let mut artifacts = Vec::with_capacity(artifact_identities.len());
    let mut artifact_paths = BTreeSet::new();
    for identity in artifact_identities {
        if !artifact_paths.insert(identity.relative_path.clone()) {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                "baseline artifact list contains a duplicate path",
            ));
        }
        artifacts.push(identity);
    }
    artifacts.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let expected_elf = format!("{}.elf", input.project_name);
    let expected_hex = format!("{}.hex", input.project_name);
    if !artifact_paths.contains(&expected_elf) || !artifact_paths.contains(&expected_hex) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "baseline must explicitly contain the current project ELF and HEX",
        ));
    }

    let sketch_source_relative = ccdb_contract
        .sketch_source
        .strip_prefix(&build)
        .map_err(|_| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                "CCDB sketch translation escaped build root",
            )
        })?
        .to_string_lossy()
        .replace('\\', "/");
    let manifest = NativeRelinkManifest {
        schema_version: NATIVE_RELINK_MANIFEST_SCHEMA_VERSION,
        engine_contract: NATIVE_RELINK_ENGINE_CONTRACT.to_string(),
        capability_class: if library_mode {
            NATIVE_RELINK_LIBRARY_CAPABILITY_CLASS.to_string()
        } else {
            NATIVE_RELINK_CAPABILITY_CLASS.to_string()
        },
        canonical_fqbn: input.canonical_fqbn.to_string(),
        profile: "release".to_string(),
        build_signature: input.build_signature.to_string(),
        cli_version: input.cli_version.to_string(),
        toolchain_key: input.toolchain_key.to_string(),
        toolchain_identity_generation: input.toolchain_identity_generation,
        access_mode: input.access_mode.to_string(),
        authorization_key: input.authorization_key.to_string(),
        project_name: input.project_name.to_string(),
        canonical_project_dir: project.to_string_lossy().into_owned(),
        canonical_build_dir: build.to_string_lossy().into_owned(),
        build_options_sha256: build_options.sha256,
        recipe: recipe_contract.manifest.clone(),
        ccdb: NativeRelinkCcdbManifest {
            schema: "release-ccdb-v2".to_string(),
            size: ccdb_identity.size,
            sha256: ccdb_identity.sha256,
            entry_count: ccdb_contract.entries.len(),
            command_graph_sha256: ccdb_contract.command_graph_sha256.clone(),
            sketch_source_relative_path: sketch_source_relative,
            sketch_object_relative_path: sketch_object.relative_path.clone(),
            sketch_command_sha256: ccdb_contract.sketch_command_sha256.clone(),
            sketch_depfile_sha256: sketch_depfile.sha256.clone(),
            non_core_non_sketch_entry_count: library_objects.len(),
        },
        core_archive,
        core_cache_identity,
        dependency_content_signature: input.dependency_content_signature.to_string(),
        library_tree_signature: input.library_tree_signature,
        library_roots,
        library_objects,
        include_analysis: input.include_analysis,
        translation_contract: translation_contract.to_string(),
        last_source: NativeRelinkSourceManifest {
            raw_sha256: sha256_bytes(input.source.as_bytes()),
            normalized_sha256: sha256_bytes(input.normalized_source.as_bytes()),
            backup_relative_path: input.backup_relative_path.to_string(),
        },
        sketch_object,
        sketch_depfile_sha256: sketch_depfile.sha256,
        outputs: NativeRelinkOutputManifest {
            artifacts,
            eep,
            size_summary: input.size_summary.to_vec(),
        },
    };
    manifest.validate_header()?;
    Ok(CapturedNativeRelinkBaseline {
        manifest,
        ccdb_contract,
        recipe_contract,
    })
}

static NATIVE_RELINK_FILE_NONCE: AtomicU64 = AtomicU64::new(0);

pub(super) fn atomic_write_regular(path: &Path, bytes: &[u8]) -> GateResult<()> {
    atomic_write_regular_with_mode(path, bytes, atomic_replace_file, true)
}

#[cfg(target_os = "windows")]
fn atomic_replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    atomic_replace_file_windows(source, destination, true)
}

// This replacement remains atomic but is intentionally not a durability
// boundary. A durable dirty marker already covers the transaction, and the
// final write-through manifest is the only state that authorizes reuse.
#[cfg(target_os = "windows")]
fn atomic_replace_subordinate_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    atomic_replace_file_windows(source, destination, false)
}

#[cfg(target_os = "windows")]
fn atomic_replace_file_windows(
    source: &Path,
    destination: &Path,
    write_through: bool,
) -> std::io::Result<()> {
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
    let flags = MOVEFILE_REPLACE_EXISTING
        | if write_through {
            MOVEFILE_WRITE_THROUGH
        } else {
            0
        };
    let result = unsafe { MoveFileExW(source_wide.as_ptr(), destination_wide.as_ptr(), flags) };
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

#[cfg(not(target_os = "windows"))]
fn atomic_replace_subordinate_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

/// Atomically publish subordinate transaction state without forcing a separate
/// storage flush for every file. The durable dirty marker remains authoritative
/// until the final manifest is committed; after a crash, absent or stale bytes
/// fail the manifest SHA-256 validation and force a clean native fallback.
fn atomic_write_subordinate_regular(path: &Path, bytes: &[u8]) -> GateResult<()> {
    atomic_write_regular_with_mode(path, bytes, atomic_replace_subordinate_file, false)
}

fn atomic_write_regular_with<F>(path: &Path, bytes: &[u8], replace: F) -> GateResult<()>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    atomic_write_regular_with_mode(path, bytes, replace, true)
}

fn atomic_write_regular_with_mode<F>(
    path: &Path,
    bytes: &[u8],
    replace: F,
    durable: bool,
) -> GateResult<()>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            format!("commit path has no parent: {}", path.display()),
        )
    })?;
    let parent = canonical_directory(parent)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                "commit file name is not UTF-8",
            )
        })?;
    if !safe_leaf_name(name) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            "commit file name is unsafe",
        ));
    }
    if let Ok(metadata) = std::fs::symlink_metadata(path)
        && (metadata_is_reparse(&metadata) || !metadata.is_file())
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::UnsafeFilesystemEntry,
            format!(
                "commit destination is not an ordinary file: {}",
                path.display()
            ),
        ));
    }
    let nonce = NATIVE_RELINK_FILE_NONCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{name}.ck-native-relink-{}-{nonce}.tmp",
        std::process::id()
    ));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                format!("cannot create atomic temporary file: {error}"),
            )
        })?;
    let result = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        // On Windows the replacement callback below uses
        // MOVEFILE_WRITE_THROUGH for the authoritative manifest.  Calling
        // sync_all before that same write-through move adds a second flush
        // without a stronger commit guarantee.  Keep the explicit file flush
        // on POSIX, where the rename callback has no equivalent durability
        // flag.
        if durable && !cfg!(windows) {
            file.sync_all()?;
        }
        drop(file);
        replace(&temporary, path)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            format!("cannot atomically commit {}: {error}", path.display()),
        ));
    }
    Ok(())
}

/// Revalidate a committed manifest without changing any compiler-owned or
/// CK-owned state.  This is the only build-state gate allowed before the dirty
/// transaction marker becomes authoritative.
fn validate_manifest_build_state_read_only(manifest: &NativeRelinkManifest) -> GateResult<()> {
    manifest.validate_header()?;
    let build = canonical_directory(Path::new(&manifest.canonical_build_dir))?;

    // These checks are independent full-content validations.  Keep the same
    // path, size and SHA-256 gates, but run them concurrently so commit time
    // is bounded by the slowest output rather than the sum of every file
    // walk.  The scoped threads borrow the manifest/build only for this call;
    // no proof is cached or reused after the final seal.
    let parallel_results = std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(7 + manifest.outputs.artifacts.len());

        {
            let build = &build;
            let expected = manifest.build_options_sha256.clone();
            handles.push(scope.spawn(move || {
                let build_options = canonical_regular_file_within(
                    &build.join("build.options.json"),
                    &[build.to_path_buf()],
                )?;
                if sha256_file(&build_options)? != expected {
                    return Err(NativeRelinkGateError::new(
                        NativeRelinkGateCode::DirtyBuild,
                        "build.options.json changed after baseline capture",
                    ));
                }
                Ok(())
            }));
        }

        {
            let build = &build;
            let expected_size = manifest.ccdb.size;
            let expected_sha256 = manifest.ccdb.sha256.clone();
            handles.push(scope.spawn(move || {
                let ccdb = file_identity_within(&build.join("compile_commands.json"), build)?;
                if ccdb.size != expected_size || ccdb.sha256 != expected_sha256 {
                    return Err(NativeRelinkGateError::new(
                        NativeRelinkGateCode::DirtyBuild,
                        "compile_commands.json changed after baseline capture",
                    ));
                }
                Ok(())
            }));
        }

        for (label, expected) in [
            ("Core archive", &manifest.core_archive),
            ("Core cache identity", &manifest.core_cache_identity),
            ("Sketch object", &manifest.sketch_object),
        ] {
            let build = &build;
            handles.push(scope.spawn(move || validate_file_binding(build, expected, label)));
        }

        {
            let manifest = manifest;
            let build = &build;
            handles.push(scope.spawn(move || validate_library_manifest_bindings(manifest, build)));
        }

        {
            let build = &build;
            let relative_path = manifest.ccdb.sketch_object_relative_path.clone();
            let expected_sketch_depfile = manifest.sketch_depfile_sha256.clone();
            let expected_ccdb_depfile = manifest.ccdb.sketch_depfile_sha256.clone();
            handles.push(scope.spawn(move || {
                let depfile = canonical_regular_file_within(
                    &build.join(relative_path).with_extension("d"),
                    &[build.to_path_buf()],
                )?;
                let depfile_sha256 = sha256_file(&depfile)?;
                if depfile_sha256 != expected_sketch_depfile
                    || depfile_sha256 != expected_ccdb_depfile
                {
                    return Err(NativeRelinkGateError::new(
                        NativeRelinkGateCode::DirtyBuild,
                        "Sketch depfile changed after baseline capture",
                    ));
                }
                Ok(())
            }));
        }

        if manifest.outputs.artifacts.len() <= MAX_PARALLEL_IDENTITY_WORKERS {
            for artifact in &manifest.outputs.artifacts {
                let build = &build;
                handles
                    .push(scope.spawn(move || {
                        validate_file_binding(build, artifact, "Firmware artifact")
                    }));
            }
        } else {
            let build = &build;
            let artifacts = &manifest.outputs.artifacts;
            handles.push(scope.spawn(move || {
                for artifact in artifacts {
                    validate_file_binding(build, artifact, "Firmware artifact")?;
                }
                Ok(())
            }));
        }

        {
            let build = &build;
            let expected = &manifest.outputs.eep;
            handles
                .push(scope.spawn(move || validate_file_binding(build, expected, "EEP artifact")));
        }

        handles
            .into_iter()
            .map(|handle| {
                handle.join().map_err(|_| {
                    NativeRelinkGateError::new(
                        NativeRelinkGateCode::DirtyBuild,
                        "parallel NativeRelink seal worker panicked",
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()
    })?;

    for result in parallel_results {
        result?;
    }
    validate_compile_only_artifacts_read_only(&build)
}

/// Prepare and seal the new compile-only state immediately before committing
/// its source backup and manifest.  Unlike the pre-dirty validation gate this
/// function deliberately removes upload-only leftovers produced by the tool
/// recipes, then performs the complete read-only seal.
fn seal_manifest_build_state_before_commit(manifest: &NativeRelinkManifest) -> GateResult<()> {
    manifest.validate_header()?;
    let build = canonical_directory(Path::new(&manifest.canonical_build_dir))?;
    remove_stale_compile_only_artifacts(&build)?;
    validate_manifest_build_state_read_only(manifest)?;
    // The pre-dirty validator deliberately permits regular prior upload state.
    // A commit seal has different semantics: after invalidation, no upload-only
    // file may survive or be recreated before the new manifest is authoritative.
    ensure_no_stale_compile_only_artifacts(&build)
}

/// Commit source backup first and the independent manifest last.
pub(super) fn commit_native_relink_baseline(
    captured: &CapturedNativeRelinkBaseline,
    manifest_path: &Path,
    backup_path: &Path,
    source: &str,
) -> GateResult<()> {
    captured.manifest.validate_header()?;
    let manifest_parent = manifest_path.parent().ok_or_else(|| {
        NativeRelinkGateError::new(NativeRelinkGateCode::InvalidPath, "manifest has no parent")
    })?;
    if backup_path.parent() != Some(manifest_parent)
        || backup_path.file_name().and_then(|value| value.to_str())
            != Path::new(&captured.manifest.last_source.backup_relative_path)
                .file_name()
                .and_then(|value| value.to_str())
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            "manifest and source backup are not the declared sibling files",
        ));
    }
    if sha256_bytes(source.as_bytes()) != captured.manifest.last_source.raw_sha256 {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "source bytes changed after baseline capture",
        ));
    }
    // The source backup is subordinate state: it cannot authorize a fast
    // build until the manifest is committed below.  Write it before the one
    // authoritative full seal so any concurrent compiler/Core/output change
    // that happens before or during the backup write is still rejected, while
    // avoiding two identical SHA-256 walks of the complete build state.
    atomic_write_subordinate_regular(backup_path, source.as_bytes())?;
    // The backup write is intentionally not the commit marker. Seal every
    // compiler-owned input/output after it so external same-size/mtime edits
    // cannot become authoritative.
    if let Err(error) = seal_manifest_build_state_before_commit(&captured.manifest) {
        // Preserve the helper's all-or-nothing contract even when it is used
        // outside the transaction wrapper. A failed subordinate cleanup is
        // still fail-closed because no manifest authority was published.
        remove_regular_file_if_present(backup_path).map_err(|cleanup_error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!(
                    "final build seal failed ({error}); source backup cleanup also failed: {cleanup_error}"
                ),
            )
        })?;
        return Err(error);
    }
    let payload = serde_json::to_vec_pretty(&captured.manifest).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            format!("cannot serialize native relink manifest: {error}"),
        )
    })?;
    atomic_write_regular(manifest_path, &payload)
}

#[derive(Debug, Clone, Default)]
pub(super) struct NativeRelinkRunControl {
    cancelled: Arc<AtomicBool>,
}

impl NativeRelinkRunControl {
    pub(super) fn new() -> Self {
        Self::default()
    }

    pub(super) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub(super) fn checkpoint(&self) -> GateResult<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::Cancelled,
                "NativeRelinkCompileOnly was cancelled",
            ))
        } else {
            Ok(())
        }
    }
}

pub(super) struct NativeRelinkRunInput<'a> {
    /// Current environment and requested source. Before the transaction its
    /// dependency signature/object/artifact fields must describe the previous
    /// committed Release baseline.
    pub baseline: NativeRelinkBaselineInput<'a>,
    pub manifest_path: &'a Path,
    pub backup_path: &'a Path,
    pub managed_build_root: &'a Path,
    /// Defense-in-depth: only the editor's compile/check action is permitted
    /// to enter this compile-only engine. Upload, warmup, and locked replay
    /// remain entirely on Arduino CLI even if a caller routes incorrectly.
    pub compile_intent: super::CompileIntent,
    pub force_rebuild: bool,
    pub attempt: u32,
    /// Set by the same explicit cache-reset path that clears the Arduino build
    /// directory. It invalidates the independent NativeRelink commit marker so
    /// the first stage of the next qualification trial must be native CLI.
    pub cache_reset_pending: bool,
}

/// A certified AVR Release dependency-graph edit.  The supplied CCDB is the
/// complete *next* graph (Core + one sketch + only the currently selected
/// library translation units); it is never merged with retained library rows.
/// This distinction is what makes library removal safe: an old object can
/// remain readable while the transaction is prepared, but it can never enter
/// the next link command or committed manifest.
pub(super) struct NativeRelinkGraphTransitionInput<'a> {
    pub baseline: NativeRelinkBaselineInput<'a>,
    pub next_ccdb: &'a [NativeCompileCommand],
    pub manifest_path: &'a Path,
    pub backup_path: &'a Path,
    pub managed_build_root: &'a Path,
    pub compile_intent: super::CompileIntent,
    pub force_rebuild: bool,
    pub attempt: u32,
    pub cache_reset_pending: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeRelinkExecutionTimings {
    pub eligibility_ms: u128,
    pub sketch_compile_ms: u128,
    pub lto_link_ms: u128,
    pub objcopy_ms: u128,
    pub size_ms: u128,
    pub commit_ms: u128,
    pub total_ms: u128,
}

#[derive(Debug)]
pub(super) enum NativeRelinkOutcome {
    NotEligible {
        code: NativeRelinkGateCode,
        reason: String,
    },
    Succeeded {
        manifest: NativeRelinkManifest,
        size_output: String,
        compiler_output: String,
        warning_count: u64,
        timings: NativeRelinkExecutionTimings,
    },
    DirtyFailure {
        code: NativeRelinkGateCode,
        reason: String,
        dirty_marker: PathBuf,
        clean_build_required: bool,
        build_was_cleaned: bool,
    },
    /// A filesystem entry exists at the retained transaction marker path, but
    /// it is not an authenticated NativeRelink marker.  It must never grant
    /// permission to delete the managed build tree or to start an automatic
    /// CLI fallback.  Only the explicit user-authorized cache-reset path may
    /// remove/quarantine this exact leaf entry.
    BlockedByUntrustedMarker {
        code: NativeRelinkGateCode,
        reason: String,
        dirty_marker: PathBuf,
    },
    Cancelled {
        reason: String,
        build_was_cleaned: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeRelinkDirtyMarker {
    schema_version: u32,
    engine_contract: String,
    run_id: String,
    previous_manifest_sha256: String,
    stage: String,
    started_unix_ms: u128,
}

const NATIVE_RELINK_DIRTY_MARKER_MAX_BYTES: u64 = 64 * 1024;

fn validate_dirty_marker(marker: &NativeRelinkDirtyMarker) -> GateResult<()> {
    const STAGES: [&str; 8] = [
        "prepared",
        "compile",
        "commit-library-graph",
        "link",
        "objcopy",
        "size",
        "commit-outputs",
        "commit-manifest",
    ];
    let run_id_valid = !marker.run_id.is_empty()
        && marker.run_id.len() <= 160
        && marker
            .run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    if marker.schema_version != NATIVE_RELINK_MANIFEST_SCHEMA_VERSION
        || marker.engine_contract != NATIVE_RELINK_ENGINE_CONTRACT
        || !run_id_valid
        || !is_sha256_hex(&marker.previous_manifest_sha256)
        || !STAGES.contains(&marker.stage.as_str())
        || marker.started_unix_ms == 0
        || marker.started_unix_ms > now_ms.saturating_add(5 * 60 * 1000)
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "dirty marker does not match the NativeRelink transaction contract",
        ));
    }
    Ok(())
}

fn read_dirty_marker(
    dirty_path: &Path,
    manifest_path: &Path,
) -> GateResult<Option<NativeRelinkDirtyMarker>> {
    let metadata = match std::fs::symlink_metadata(dirty_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                format!("cannot inspect dirty marker: {error}"),
            ));
        }
    };
    if metadata_is_reparse(&metadata)
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > NATIVE_RELINK_DIRTY_MARKER_MAX_BYTES
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::UnsafeFilesystemEntry,
            "dirty marker is not a bounded ordinary file",
        ));
    }
    let parent = dirty_path.parent().ok_or_else(|| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            "dirty marker has no parent",
        )
    })?;
    let canonical = canonical_regular_file_within(dirty_path, &[parent.to_path_buf()])?;
    let raw = std::fs::read(&canonical).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            format!("cannot read dirty marker: {error}"),
        )
    })?;
    if raw.len() as u64 != metadata.len() || raw.len() as u64 > NATIVE_RELINK_DIRTY_MARKER_MAX_BYTES
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "dirty marker changed while it was being read",
        ));
    }
    let marker: NativeRelinkDirtyMarker = serde_json::from_slice(&raw).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            format!("cannot parse dirty marker: {error}"),
        )
    })?;
    validate_dirty_marker(&marker)?;

    match std::fs::symlink_metadata(manifest_path) {
        Ok(metadata) if metadata.is_file() && !metadata_is_reparse(&metadata) => {
            let (_, manifest_sha256) = read_manifest(manifest_path)?;
            if manifest_sha256 != marker.previous_manifest_sha256 {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::InvalidManifest,
                    "dirty marker is not bound to the current NativeRelink manifest",
                ));
            }
        }
        Ok(_) => {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::UnsafeFilesystemEntry,
                "NativeRelink manifest beside dirty marker is not an ordinary file",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::MissingFile,
                "NativeRelink manifest beside dirty marker is missing; the marker cannot authorize cleanup",
            ));
        }
        Err(error) => {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                format!("cannot inspect manifest beside dirty marker: {error}"),
            ));
        }
    }
    Ok(Some(marker))
}

#[derive(Debug)]
struct DirectCommandOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn native_relink_run_id() -> String {
    let nonce = NATIVE_RELINK_FILE_NONCE.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{timestamp}-{nonce}", std::process::id())
}

fn read_manifest(path: &Path) -> GateResult<(NativeRelinkManifest, String)> {
    let parent = path.parent().ok_or_else(|| {
        NativeRelinkGateError::new(NativeRelinkGateCode::InvalidPath, "manifest has no parent")
    })?;
    let canonical = canonical_regular_file_within(path, &[parent.to_path_buf()])?;
    let metadata = std::fs::metadata(&canonical).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::MissingFile,
            format!("cannot inspect native relink manifest: {error}"),
        )
    })?;
    if metadata.len() > 1024 * 1024 {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "native relink manifest exceeds 1 MiB",
        ));
    }
    let raw = std::fs::read(&canonical).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::MissingFile,
            format!("cannot read native relink manifest: {error}"),
        )
    })?;
    let parsed: NativeRelinkManifest = serde_json::from_slice(&raw).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            format!("cannot parse native relink manifest: {error}"),
        )
    })?;
    parsed.validate_header()?;
    Ok((parsed, sha256_bytes(&raw)))
}

pub(super) fn committed_manifest_uses_bounded_libraries(path: &Path) -> GateResult<bool> {
    let (manifest, _) = read_manifest(path)?;
    Ok(!manifest.library_roots.is_empty())
}

fn write_dirty_marker(path: &Path, marker: &NativeRelinkDirtyMarker) -> GateResult<()> {
    let payload = serde_json::to_vec_pretty(marker).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::DirtyBuild,
            format!("cannot serialize dirty marker: {error}"),
        )
    })?;
    atomic_write_regular(path, &payload)
}

fn update_dirty_stage(
    path: &Path,
    marker: &mut NativeRelinkDirtyMarker,
    stage: &str,
) -> GateResult<()> {
    marker.stage = stage.to_string();
    write_dirty_marker(path, marker)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NativeRelinkTranslationPlan {
    contract: &'static str,
    inject_arduino_header: bool,
}

const CK_MSTIMER2_AVR_SCAFFOLD: &str = r#"#if defined(ARDUINO_ARCH_AVR)
#include <MsTimer2.h>
#define CK_MSTIMER2_RUN() ((void)0)
#else
class CKMsTimer2Compat {
public:
  typedef void (*Callback)();
  void set(unsigned long intervalMs, Callback cb) {
    intervalMs_ = intervalMs;
    callback_ = cb;
    lastTick_ = millis();
  }
  void start() {
    running_ = true;
    lastTick_ = millis();
  }
  void stop() { running_ = false; }
  void run() {
    if (!running_ || callback_ == nullptr || intervalMs_ == 0) return;
    unsigned long now = millis();
    if ((now - lastTick_) >= intervalMs_) {
      lastTick_ += intervalMs_;
      callback_();
    }
  }
private:
  unsigned long intervalMs_ = 0;
  unsigned long lastTick_ = 0;
  bool running_ = false;
  Callback callback_ = nullptr;
};
static CKMsTimer2Compat ck_ms_timer2;
namespace MsTimer2 {
  inline void set(unsigned long ms, CKMsTimer2Compat::Callback cb) { ck_ms_timer2.set(ms, cb); }
  inline void start() { ck_ms_timer2.start(); }
  inline void stop() { ck_ms_timer2.stop(); }
}
#define CK_MSTIMER2_RUN() ck_ms_timer2.run()
#endif"#;

fn strip_exact_ck_mapping_suffix<'a>(
    line: &'a str,
    statement: &'a str,
    marker_prefix: &str,
) -> Option<&'a str> {
    let suffix = line.strip_prefix(statement)?;
    if suffix.is_empty() {
        return Some(statement);
    }
    let marker = suffix.trim();
    let payload = marker.strip_prefix(marker_prefix)?.strip_suffix(" */")?;
    if payload.is_empty()
        || !payload.len().is_multiple_of(2)
        || !payload.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    let decoded = String::from_utf8(hex::decode(payload).ok()?).ok()?;
    if marker_prefix == "/* @ck-source-begin:v1:" {
        let value = serde_json::from_str::<serde_json::Value>(&decoded).ok()?;
        let object = value.as_object()?;
        if object.len() != 5
            || object.get("blockType")?.as_str()? != "control_mstimer2_every"
            || object.get("section")?.as_str()? != "definition"
            || object
                .get("boundaryId")
                .and_then(serde_json::Value::as_str)
                .is_none_or(str::is_empty)
            || object
                .get("blockId")
                .and_then(serde_json::Value::as_str)
                .is_none_or(str::is_empty)
        {
            return None;
        }
    } else if decoded.trim().is_empty() {
        return None;
    }
    Some(statement)
}

fn mstimer2_translation_surrogate(source: &str) -> GateResult<Option<String>> {
    let normalized = source.replace("\r\n", "\n");
    if !normalized.starts_with("#if defined(ARDUINO_ARCH_AVR)") {
        return Ok(None);
    }
    let lines = normalized.split_inclusive('\n').collect::<Vec<_>>();
    let Some(end_index) = lines
        .iter()
        .position(|line| line.trim_end_matches(['\r', '\n']).starts_with("#endif"))
    else {
        return Err(translation_error(
            NativeRelinkGateCode::TranslationMalformed,
            "CK MsTimer2 scaffold has no closing #endif",
        ));
    };
    let mut scaffold_lines = lines[..=end_index]
        .iter()
        .map(|line| line.trim_end_matches(['\r', '\n']).to_string())
        .collect::<Vec<_>>();
    let first = strip_exact_ck_mapping_suffix(
        &scaffold_lines[0],
        "#if defined(ARDUINO_ARCH_AVR)",
        "/* @ck-source-begin:v1:",
    )
    .ok_or_else(|| {
        translation_error(
            NativeRelinkGateCode::TranslationUnsupported,
            "CK MsTimer2 scaffold opening marker is not exact",
        )
    })?;
    scaffold_lines[0] = first.to_string();
    let last_index = scaffold_lines.len() - 1;
    let last = strip_exact_ck_mapping_suffix(
        &scaffold_lines[last_index],
        "#endif",
        "/* @ck-source-end:v1:",
    )
    .ok_or_else(|| {
        translation_error(
            NativeRelinkGateCode::TranslationUnsupported,
            "CK MsTimer2 scaffold closing marker is not exact",
        )
    })?;
    scaffold_lines[last_index] = last.to_string();
    if scaffold_lines.join("\n") != CK_MSTIMER2_AVR_SCAFFOLD {
        return Err(translation_error(
            NativeRelinkGateCode::TranslationUnsupported,
            "CK MsTimer2 compatibility scaffold differs from the audited generator template",
        ));
    }
    let rest = lines[end_index + 1..].concat();
    if rest.contains("CKMsTimer2Compat")
        || rest.contains("#include <MsTimer2.h>")
        || rest.contains("#include \"MsTimer2.h\"")
    {
        return Err(translation_error(
            NativeRelinkGateCode::TranslationUnsupported,
            "CK MsTimer2 scaffold or include is duplicated",
        ));
    }
    Ok(Some(format!("#include <Arduino.h>\n{rest}")))
}

/// Admit the one conditional include graph that CK itself emits for MsTimer2.
///
/// This is deliberately narrower than `synthesis_safe`: the complete generated
/// scaffold (including trusted source-map markers) must match the audited
/// template, the manifest must contain only `MsTimer2.h`, and the remainder may
/// not contain another preprocessing directive.  Consequently this helper does
/// not turn arbitrary conditional or macro includes into synthetic graph input.
pub(super) fn validate_audited_ck_mstimer2_graph_source(
    source: &str,
    include_analysis: &NativeRelinkIncludeManifest,
) -> GateResult<()> {
    if include_analysis.synthesis_safe || include_analysis.headers != ["mstimer2.h"] {
        return Err(translation_error(
            NativeRelinkGateCode::TranslationUnsupported,
            "audited CK MsTimer2 graph requires the exact conditional MsTimer2.h manifest",
        ));
    }
    let Some(surrogate) = mstimer2_translation_surrogate(source)? else {
        return Err(translation_error(
            NativeRelinkGateCode::TranslationUnsupported,
            "conditional include graph is not the audited CK MsTimer2 scaffold",
        ));
    };
    let remainder = surrogate
        .strip_prefix("#include <Arduino.h>\n")
        .ok_or_else(|| {
            translation_error(
                NativeRelinkGateCode::TranslationMalformed,
                "audited CK MsTimer2 surrogate prefix is invalid",
            )
        })?;
    if remainder.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with('#') || line.starts_with("%:")
    }) {
        return Err(translation_error(
            NativeRelinkGateCode::TranslationUnsupported,
            "audited CK MsTimer2 source has an additional preprocessing directive",
        ));
    }
    validate_direct_cpp_translation(&surrogate)?;
    Ok(())
}

/// Graph-transition runner gate. Ordinary literal graphs keep the generic
/// synthesis path; the sole conditional exception must pass the complete
/// audited MsTimer2 source proof above.
fn validate_graph_transition_include_source(
    source: &str,
    include_analysis: &NativeRelinkIncludeManifest,
) -> GateResult<()> {
    if include_analysis.synthesis_safe {
        Ok(())
    } else {
        validate_audited_ck_mstimer2_graph_source(source, include_analysis)
    }
}

fn valid_generic_ck_marker_payload(prefix: &str, payload: &str) -> bool {
    if payload.is_empty()
        || !payload.len().is_multiple_of(2)
        || !payload.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return false;
    }
    let Ok(decoded) = hex::decode(payload)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or(())
    else {
        return false;
    };
    if prefix == "/* @ck-source-begin:v1:" {
        let Ok(serde_json::Value::Object(value)) = serde_json::from_str(&decoded) else {
            return false;
        };
        const KEYS: [&str; 5] = [
            "boundaryId",
            "blockId",
            "blockType",
            "section",
            "confidence",
        ];
        value.len() == KEYS.len()
            && value.keys().all(|key| KEYS.contains(&key.as_str()))
            && KEYS.iter().all(|key| {
                value
                    .get(*key)
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|v| !v.is_empty())
            })
    } else {
        !decoded.trim().is_empty()
    }
}

fn strip_trusted_ck_marker_suffix(line: &str) -> Option<&str> {
    let marker_start = line.find("/* @ck")?;
    if marker_start == 0 || !line.as_bytes()[marker_start - 1].is_ascii_whitespace() {
        return None;
    }
    let mut cursor = marker_start;
    while cursor < line.len() {
        while cursor < line.len() && line.as_bytes()[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor == line.len() {
            break;
        }
        let candidate = &line[cursor..];
        let prefix = [
            "/* @ck-source-begin:v1:",
            "/* @ck-source-end:v1:",
            "/* @ck:v1:",
        ]
        .into_iter()
        .find(|prefix| candidate.starts_with(prefix))?;
        let payload_start = cursor + prefix.len();
        let suffix_offset = line[payload_start..].find(" */")?;
        let payload_end = payload_start + suffix_offset;
        if !valid_generic_ck_marker_payload(prefix, &line[payload_start..payload_end]) {
            return None;
        }
        cursor = payload_end + " */".len();
    }
    Some(line[..marker_start].trim_end())
}

fn parse_exact_literal_include(line: &str) -> Option<String> {
    let raw = line.trim_end_matches(['\r', '\n']);
    let without_markers = if raw.contains("/* @ck") {
        strip_trusted_ck_marker_suffix(raw)?
    } else {
        raw
    };
    let trimmed = without_markers.trim();
    let rest = trimmed.strip_prefix("#include")?.trim_start();
    let (header, suffix) = if let Some(rest) = rest.strip_prefix('<') {
        let end = rest.find('>')?;
        (&rest[..end], &rest[end + 1..])
    } else if let Some(rest) = rest.strip_prefix('"') {
        let end = rest.find('"')?;
        (&rest[..end], &rest[end + 1..])
    } else {
        return None;
    };
    if header.trim().is_empty() || !suffix.trim().is_empty() {
        return None;
    }
    Some(header.trim().replace('\\', "/").to_ascii_lowercase())
}

fn explicit_library_translation_surrogate(
    source: &str,
    expected_headers: &[String],
) -> GateResult<String> {
    let expected = expected_headers
        .iter()
        .map(|header| header.replace('\\', "/").to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let mut observed = BTreeSet::new();
    let mut surrogate = String::from("#include <Arduino.h>\n");
    for line in source.split_inclusive('\n') {
        if let Some(header) = parse_exact_literal_include(line) {
            if !expected.contains(&header) {
                return Err(translation_error(
                    NativeRelinkGateCode::TranslationUnsupported,
                    format!("literal include is outside the admitted library graph: {header}"),
                ));
            }
            observed.insert(header);
            surrogate.push('\n');
        } else {
            surrogate.push_str(line);
        }
    }
    if observed != expected {
        return Err(translation_error(
            NativeRelinkGateCode::TranslationUnsupported,
            "source literal includes differ from the admitted include manifest",
        ));
    }
    Ok(surrogate)
}

fn validate_native_relink_translation(
    source: &str,
    include_analysis: &NativeRelinkIncludeManifest,
    library_mode: bool,
) -> GateResult<NativeRelinkTranslationPlan> {
    if !library_mode {
        let directives = source
            .lines()
            .filter(|line| line.trim_start().starts_with('#'))
            .collect::<Vec<_>>();
        if directives.is_empty() {
            if include_analysis.headers != ["arduino.h"] || !include_analysis.synthesis_safe {
                return Err(translation_error(
                    NativeRelinkGateCode::TranslationUnsupported,
                    "implicit Arduino header requires the exact synthesis-safe core include manifest",
                ));
            }
            let surrogate = format!("#include <Arduino.h>\n{source}");
            validate_direct_cpp_translation(&surrogate)?;
            return Ok(NativeRelinkTranslationPlan {
                contract: DIRECT_CPP_IMPLICIT_ARDUINO_TRANSLATION_CONTRACT,
                inject_arduino_header: true,
            });
        }
        let explicit_headers = directives
            .iter()
            .filter_map(|line| parse_exact_literal_include(line))
            .collect::<Vec<_>>();
        if directives.len() != 1 || explicit_headers != ["arduino.h"] {
            return Err(translation_error(
                NativeRelinkGateCode::TranslationUnsupported,
                "core-only source preprocessing is not the exact Arduino.h literal include",
            ));
        }
        validate_direct_cpp_translation(source)?;
        return Ok(NativeRelinkTranslationPlan {
            contract: DIRECT_CPP_TRANSLATION_CONTRACT,
            inject_arduino_header: false,
        });
    }
    if let Some(surrogate) = mstimer2_translation_surrogate(source)? {
        if include_analysis.headers != ["mstimer2.h"] {
            return Err(translation_error(
                NativeRelinkGateCode::TranslationUnsupported,
                "CK MsTimer2 scaffold requires the exact MsTimer2.h include manifest",
            ));
        }
        validate_direct_cpp_translation(&surrogate)?;
        return Ok(NativeRelinkTranslationPlan {
            contract: CK_MSTIMER2_AVR_TRANSLATION_CONTRACT,
            inject_arduino_header: true,
        });
    }
    if !include_analysis.synthesis_safe {
        return Err(translation_error(
            NativeRelinkGateCode::TranslationUnsupported,
            "library source contains conditional or non-literal preprocessing outside the audited CK scaffold",
        ));
    }
    let surrogate = explicit_library_translation_surrogate(source, &include_analysis.headers)?;
    validate_direct_cpp_translation(&surrogate)?;
    Ok(NativeRelinkTranslationPlan {
        contract: DIRECT_CPP_LIBRARY_TRANSLATION_CONTRACT,
        inject_arduino_header: true,
    })
}

fn render_direct_cpp(
    source: &str,
    sketch_ino: &Path,
    include_analysis: &NativeRelinkIncludeManifest,
    library_mode: bool,
) -> GateResult<String> {
    let translation = validate_native_relink_translation(source, include_analysis, library_mode)?;
    let value = sketch_ino.to_str().ok_or_else(|| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::TranslationUnsupported,
            "canonical root sketch path is not UTF-8",
        )
    })?;
    let mut escaped = String::with_capacity(value.len() + 16);
    use std::fmt::Write as _;
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            control if control.is_control() => {
                let mut utf8 = [0u8; 4];
                for byte in control.encode_utf8(&mut utf8).as_bytes() {
                    write!(&mut escaped, "\\{:03o}", byte).map_err(|error| {
                        NativeRelinkGateError::new(
                            NativeRelinkGateCode::TranslationUnsupported,
                            format!("cannot escape #line path: {error}"),
                        )
                    })?;
                }
            }
            ordinary => escaped.push(ordinary),
        }
    }
    let prefix = if translation.inject_arduino_header {
        "#include <Arduino.h>\n"
    } else {
        ""
    };
    Ok(format!("{prefix}#line 1 \"{escaped}\"\n{source}"))
}

fn replace_command_output(
    tokens: &[String],
    directory: &Path,
    output: &Path,
) -> GateResult<Vec<String>> {
    canonical_output_path_within(
        output,
        output.parent().ok_or_else(|| {
            NativeRelinkGateError::new(NativeRelinkGateCode::InvalidPath, "output has no parent")
        })?,
    )?;
    let mut rewritten = tokens.to_vec();
    let positions = rewritten
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (token == "-o").then_some(index))
        .collect::<Vec<_>>();
    if positions.len() != 1 || positions[0] + 1 >= rewritten.len() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::UnsupportedCommand,
            "command has no unique output token",
        ));
    }
    let _ = command_output_token(tokens, directory)?;
    rewritten[positions[0] + 1] = output.to_string_lossy().into_owned();
    Ok(rewritten)
}

fn replace_exact_path_token(
    tokens: &[String],
    directory: &Path,
    from: &Path,
    to: &Path,
) -> GateResult<Vec<String>> {
    let from_key = path_key(from);
    let mut count = 0usize;
    let rewritten = tokens
        .iter()
        .map(|token| {
            if !token.starts_with('-')
                && path_key(&resolve_token_path(token, directory)) == from_key
            {
                count += 1;
                to.to_string_lossy().into_owned()
            } else {
                token.clone()
            }
        })
        .collect::<Vec<_>>();
    if count != 1 {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::RecipeMismatch,
            format!(
                "expected exactly one path token for {} but observed {count}",
                from.display()
            ),
        ));
    }
    Ok(rewritten)
}

fn replace_optional_exact_path_token(
    tokens: &[String],
    directory: &Path,
    from: &Path,
    to: &Path,
) -> GateResult<Vec<String>> {
    let from_key = path_key(from);
    let mut count = 0usize;
    let rewritten = tokens
        .iter()
        .map(|token| {
            if !token.starts_with('-')
                && path_key(&resolve_token_path(token, directory)) == from_key
            {
                count += 1;
                to.to_string_lossy().into_owned()
            } else {
                token.clone()
            }
        })
        .collect::<Vec<_>>();
    if count > 1 {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::RecipeMismatch,
            format!(
                "expected at most one optional path token for {} but observed {count}",
                from.display()
            ),
        ));
    }
    Ok(rewritten)
}

#[derive(Debug, Clone)]
pub(super) struct DepfileToken {
    start: usize,
    end: usize,
    pub decoded: String,
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

/// Parse the deliberately small Make depfile subset emitted by AVR GCC.
/// Exactly one rule is accepted; Make variables, comments and secondary rules
/// fail closed. Spans let the two transaction paths be replaced while all
/// other dependency bytes remain untouched.
pub(super) fn parse_single_rule_depfile(
    raw: &str,
) -> GateResult<(Vec<DepfileToken>, Vec<DepfileToken>)> {
    let bytes = raw.as_bytes();
    let mut targets = Vec::new();
    let mut dependencies = Vec::new();
    let mut target_side = true;
    let mut rule_separator_seen = false;
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
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbUnsupportedEntry,
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
            if rule_separator_seen {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::CcdbAmbiguous,
                    format!(
                        "depfile contains multiple rules or an ambiguous colon at byte {index}: {:?}",
                        raw.chars().take(512).collect::<String>()
                    ),
                ));
            }
            rule_separator_seen = true;
            target_side = false;
            index += 1;
            continue;
        }
        start.get_or_insert(index);
        let character = raw[index..].chars().next().ok_or_else(|| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbUnsupportedEntry,
                "depfile is not valid UTF-8",
            )
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
    if !rule_separator_seen || targets.len() != 1 || dependencies.is_empty() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbAmbiguous,
            "depfile must contain exactly one target and one non-empty dependency list",
        ));
    }
    Ok((targets, dependencies))
}

fn make_depfile_path(path: &Path) -> GateResult<String> {
    let value = path.to_str().ok_or_else(|| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            "depfile replacement path is not UTF-8",
        )
    })?;
    // Keep GCC depfiles in the same conventional Windows spelling used for
    // child-process arguments.  A `\\?\\C:\\...` token begins with two
    // backslashes; Make escaping collapses the first pair and the generic
    // dependency parser then sees a relative `\?\C:\...` path.  The path was
    // already canonicalized and contained by the managed build root, so this
    // conversion preserves identity while keeping the depfile round-trippable.
    let value = process_path_token(value);
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
    transaction_object: &Path,
    canonical_object: &Path,
    transaction_source: &Path,
    canonical_source: &Path,
    managed_roots: &[PathBuf],
) -> GateResult<()> {
    let metadata = std::fs::metadata(depfile).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::MissingFile,
            format!("cannot inspect transaction depfile: {error}"),
        )
    })?;
    if metadata.len() == 0 || metadata.len() > NATIVE_RELINK_CCDB_MAX_BYTES {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbUnsupportedEntry,
            "transaction depfile is empty or exceeds 16 MiB",
        ));
    }
    let raw = std::fs::read_to_string(depfile).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbUnsupportedEntry,
            format!("cannot read transaction depfile as UTF-8: {error}"),
        )
    })?;
    let (targets, dependencies) = parse_single_rule_depfile(&raw)?;
    let target = resolve_token_path(&targets[0].decoded, compile_directory);
    if path_key(&target) != path_key(transaction_object) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbAmbiguous,
            "depfile target is not the transaction sketch object",
        ));
    }
    let transaction_key = path_key(transaction_source);
    let transaction_root = transaction_source
        .ancestors()
        .nth(2)
        .ok_or_else(|| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                "transaction source has no transaction root",
            )
        })?
        .to_path_buf();
    let mut source_matches = Vec::new();
    for token in &dependencies {
        let path = resolve_token_path(&token.decoded, compile_directory);
        if path_key(&path) == transaction_key {
            source_matches.push(token.clone());
            continue;
        }
        let lexical = lexical_absolute_path(&path)?;
        if lexical.starts_with(&transaction_root) {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbAmbiguous,
                "depfile contains an unexpected transaction-local dependency",
            ));
        }
        let _ = canonical_regular_file_within(&lexical, managed_roots)?;
    }
    if source_matches.len() != 1 {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbAmbiguous,
            format!(
                "depfile must contain the transaction source exactly once (observed {})",
                source_matches.len()
            ),
        ));
    }
    let mut replacements = vec![
        (
            targets[0].start,
            targets[0].end,
            make_depfile_path(canonical_object)?,
        ),
        (
            source_matches[0].start,
            source_matches[0].end,
            make_depfile_path(canonical_source)?,
        ),
    ];
    replacements.sort_by_key(|(start, _, _)| *start);
    let mut rewritten = String::with_capacity(raw.len() + 64);
    let mut cursor = 0usize;
    for (start, end, replacement) in replacements {
        if start < cursor || end < start || end > raw.len() {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbAmbiguous,
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
    if rewritten_key.contains(&path_key(&transaction_root)) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbAmbiguous,
            "rewritten depfile still contains the transaction path",
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
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbAmbiguous,
            "rewritten depfile does not bind the canonical sketch paths",
        ));
    }
    atomic_write_regular(depfile, rewritten.as_bytes())
}

/// Rewrite a dependency file produced for a transaction-local object whose
/// source is an already existing, admitted Arduino library source.  Unlike the
/// sketch helper above there is no transaction-local source to substitute;
/// every dependency must already be an ordinary file below one of the exact
/// source/tool/build roots and the declared library source must occur once.
fn rewrite_library_transaction_depfile(
    depfile: &Path,
    compile_directory: &Path,
    transaction_object: &Path,
    canonical_object: &Path,
    canonical_source: &Path,
    managed_roots: &[PathBuf],
) -> GateResult<()> {
    let metadata = std::fs::metadata(depfile).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::MissingFile,
            format!("cannot inspect library transaction depfile: {error}"),
        )
    })?;
    if metadata.len() == 0 || metadata.len() > NATIVE_RELINK_CCDB_MAX_BYTES {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbUnsupportedEntry,
            "library transaction depfile is empty or exceeds 16 MiB",
        ));
    }
    let raw = std::fs::read_to_string(depfile).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbUnsupportedEntry,
            format!("cannot read library transaction depfile as UTF-8: {error}"),
        )
    })?;
    let (targets, dependencies) = parse_single_rule_depfile(&raw)?;
    let target = resolve_token_path(&targets[0].decoded, compile_directory);
    if path_key(&target) != path_key(transaction_object) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbAmbiguous,
            "library depfile target is not its transaction object",
        ));
    }

    let source_key = path_key(canonical_source);
    let mut source_count = 0usize;
    let mut rewritten_dependencies = Vec::with_capacity(dependencies.len());
    for token in dependencies {
        let dependency = resolve_token_path(&token.decoded, compile_directory);
        let lexical = lexical_absolute_path(&dependency)?;
        let canonical = canonical_regular_file_within(&lexical, managed_roots)?;
        if path_key(&canonical) == source_key {
            source_count += 1;
        }
        rewritten_dependencies.push(make_depfile_path(&canonical)?);
    }
    if source_count != 1 {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbAmbiguous,
            format!(
                "library transaction depfile must bind its exact source once (observed {source_count})"
            ),
        ));
    }
    let rewritten = format!(
        "{}: {}\n",
        make_depfile_path(canonical_object)?,
        rewritten_dependencies.join(" ")
    );
    atomic_write_regular(depfile, rewritten.as_bytes())
}

fn runnable_tokens(tokens: &[String], tool_roots: &[PathBuf]) -> GateResult<Vec<String>> {
    if tokens.is_empty() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::UnsupportedCommand,
            "direct command has no tokens",
        ));
    }
    let executable = validate_executable(tokens, tool_roots)?;
    let mut runnable = tokens.to_vec();
    // `canonicalize` intentionally returns an extended Windows path
    // (`\\?\\C:\\...`) so the trust checks are not limited by MAX_PATH.  MinGW
    // AVR tools, however, interpret that spelling as `//?/c:/...` and then
    // fail to locate their own `lib/gcc/.../device-specs` directory.  Validate
    // the extended path first, then hand the same file to the child in the
    // conventional DOS spelling.  This changes representation only; it does
    // not broaden the managed-root or hash checks above.
    runnable[0] = process_path_token(&executable.to_string_lossy());
    for token in &mut runnable[1..] {
        *token = process_path_token(token);
    }
    Ok(runnable)
}

#[cfg(windows)]
fn process_path_token(token: &str) -> String {
    if let Some(rest) = token.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = token.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        token.to_string()
    }
}

#[cfg(not(windows))]
fn process_path_token(token: &str) -> String {
    token.to_string()
}

async fn execute_direct_command(
    tokens: &[String],
    directory: &Path,
    tool_roots: &[PathBuf],
    control: &NativeRelinkRunControl,
) -> GateResult<DirectCommandOutput> {
    control.checkpoint()?;
    super::current_build_cancellation_checkpoint().map_err(|error| {
        NativeRelinkGateError::new(NativeRelinkGateCode::Cancelled, error.to_string())
    })?;
    let runnable = runnable_tokens(tokens, tool_roots)?;
    let mut command = Command::new(&runnable[0]);
    command.args(&runnable[1..]);
    command.current_dir(process_path_token(&directory.to_string_lossy()));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x0800_0000);
    }
    let output = super::managed_command_output(&mut command)
        .await
        .map_err(|error| {
            NativeRelinkGateError::new(
                if error.kind() == std::io::ErrorKind::Interrupted {
                    NativeRelinkGateCode::Cancelled
                } else {
                    NativeRelinkGateCode::ExecutionFailed
                },
                format!("cannot execute {}: {error}", runnable[0]),
            )
        })?;
    control.checkpoint()?;
    super::current_build_cancellation_checkpoint().map_err(|error| {
        NativeRelinkGateError::new(NativeRelinkGateCode::Cancelled, error.to_string())
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        let detail = detail.chars().take(2048).collect::<String>();
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::ExecutionFailed,
            format!("direct tool exited with {}: {detail}", output.status),
        ));
    }
    Ok(DirectCommandOutput {
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

fn commit_transaction_file(source: &Path, destination: &Path, build: &Path) -> GateResult<()> {
    let source = canonical_regular_file_within(source, &[build.to_path_buf()])?;
    let destination = canonical_output_path_within(destination, build)?;
    atomic_replace_subordinate_file(&source, &destination).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::DirtyBuild,
            format!(
                "cannot commit transaction file {} -> {}: {error}",
                source.display(),
                destination.display()
            ),
        )
    })
}

fn is_stale_compile_only_artifact_name(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_lowercase();
    name.ends_with(".with_bootloader.hex")
        || name.ends_with(".with_bootloader.bin")
        || name == ".ck-upload-artifacts.json"
}

fn remove_stale_compile_only_artifacts(build: &Path) -> GateResult<()> {
    for entry in std::fs::read_dir(build).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::DirtyBuild,
            format!("cannot inspect build outputs: {error}"),
        )
    })? {
        let entry = entry.map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!("cannot inspect build output entry: {error}"),
            )
        })?;
        if !is_stale_compile_only_artifact_name(&entry.file_name()) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!("cannot inspect stale output: {error}"),
            )
        })?;
        if metadata_is_reparse(&metadata) || !metadata.is_file() {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::UnsafeFilesystemEntry,
                format!(
                    "stale artifact is not an ordinary file: {}",
                    entry.path().display()
                ),
            ));
        }
        std::fs::remove_file(entry.path()).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!("cannot remove stale compile-only artifact: {error}"),
            )
        })?;
    }
    Ok(())
}

/// Inspect upload-only residue without changing it.
///
/// A successful Desktop compile may seal the current firmware for a later
/// upload after the NativeRelink baseline has been committed.  That creates a
/// regular `.ck-upload-artifacts.json` beside the compiler outputs.  A future
/// graph transition must preserve that still-authoritative old upload state
/// until its dirty marker has been installed; rejecting every such file here
/// would make every dependency add/remove miss the fast path.  Non-ordinary
/// entries remain fail-closed because they cannot be invalidated safely once
/// the transaction starts.
fn validate_compile_only_artifacts_read_only(build: &Path) -> GateResult<()> {
    for entry in std::fs::read_dir(build).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::DirtyBuild,
            format!("cannot inspect compile-only outputs: {error}"),
        )
    })? {
        let entry = entry.map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!("cannot inspect compile-only output entry: {error}"),
            )
        })?;
        if !is_stale_compile_only_artifact_name(&entry.file_name()) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!("cannot inspect upload-only output: {error}"),
            )
        })?;
        if metadata_is_reparse(&metadata) || !metadata.is_file() {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::UnsafeFilesystemEntry,
                format!(
                    "upload-only artifact is not an ordinary file: {}",
                    entry.path().display()
                ),
            ));
        }
    }
    Ok(())
}

fn ensure_no_stale_compile_only_artifacts(build: &Path) -> GateResult<()> {
    for entry in std::fs::read_dir(build).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::DirtyBuild,
            format!("cannot recheck compile-only outputs: {error}"),
        )
    })? {
        let entry = entry.map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!("cannot recheck compile-only output entry: {error}"),
            )
        })?;
        if is_stale_compile_only_artifact_name(&entry.file_name()) {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!(
                    "upload-only artifact was recreated during compile-only commit: {}",
                    entry.path().display()
                ),
            ));
        }
    }
    Ok(())
}

fn validate_file_binding(
    build: &Path,
    expected: &NativeRelinkFileIdentity,
    label: &str,
) -> GateResult<()> {
    let path = build.join(&expected.relative_path);
    let actual = file_identity_within(&path, build).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::DirtyBuild,
            format!("{label} cannot be revalidated after the final lease: {error}"),
        )
    })?;
    if actual != *expected {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::DirtyBuild,
            format!("{label} changed after the final lease: {}", path.display()),
        ));
    }
    Ok(())
}

#[cfg(test)]
fn validate_final_commit_state(
    build: &Path,
    canonical_paths: &[&Path],
    expected_outputs: &[NativeRelinkContentIdentity],
    core_archive: &NativeRelinkFileIdentity,
    core_cache_identity: &NativeRelinkFileIdentity,
) -> GateResult<()> {
    // The lease callback is external code. Treat everything it could have
    // touched as untrusted and seal the compile-only state again before the
    // manifest becomes authoritative.
    remove_stale_compile_only_artifacts(build)?;
    validate_content_bindings(canonical_paths, build, expected_outputs)?;
    validate_file_binding(build, core_archive, "Core archive")?;
    validate_file_binding(build, core_cache_identity, "Core cache identity")?;
    ensure_no_stale_compile_only_artifacts(build)
}

fn warning_count(text: &str) -> u64 {
    text.lines()
        .filter(|line| line.to_ascii_lowercase().contains("warning:"))
        .count() as u64
}

fn remove_regular_file_if_present(path: &Path) -> GateResult<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata_is_reparse(&metadata) || !metadata.is_file() {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::UnsafeFilesystemEntry,
                    format!(
                        "refusing to remove non-regular state file: {}",
                        path.display()
                    ),
                ));
            }
            std::fs::remove_file(path).map_err(|error| {
                NativeRelinkGateError::new(
                    NativeRelinkGateCode::DirtyBuild,
                    format!("cannot remove state file {}: {error}", path.display()),
                )
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            format!("cannot inspect state file {}: {error}", path.display()),
        )),
    }
}

pub(super) fn invalidate_native_relink_baseline(
    manifest_path: &Path,
    backup_path: &Path,
) -> GateResult<()> {
    // The manifest is the independent authority/commit marker.  Remove the
    // subordinate source backup first and revoke authority last.  If backup
    // removal fails, the previously committed pair remains intact; if the
    // final manifest removal fails, the manifest is fail-closed because its
    // bound backup is already absent.
    remove_regular_file_if_present(backup_path)?;
    remove_regular_file_if_present(manifest_path)
}

fn clean_managed_build_directory(build: &Path, managed_root: &Path) -> GateResult<()> {
    if !build.exists() {
        return Ok(());
    }
    let root = canonical_directory(managed_root)?;
    let canonical_build = canonical_directory(build)?;
    if canonical_build == root
        || canonical_build.parent() != Some(root.as_path())
        || canonical_build.file_name().is_none()
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            format!(
                "refusing to recursively clean build outside a direct managed child: {}",
                canonical_build.display()
            ),
        ));
    }
    let raw_root_key = path_key(managed_root);
    let Some(raw_root) = build
        .ancestors()
        .find(|ancestor| path_key(ancestor) == raw_root_key)
    else {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            "raw build path is outside its managed root",
        ));
    };
    ensure_ordinary_ancestors(build, raw_root)?;
    std::fs::remove_dir_all(&canonical_build).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::DirtyBuild,
            format!(
                "cannot clean dirty build {}: {error}",
                canonical_build.display()
            ),
        )
    })
}

fn cleanup_after_direct_failure(
    manifest_path: &Path,
    backup_path: &Path,
    dirty_path: &Path,
    build: &Path,
    managed_root: &Path,
) -> bool {
    // A trusted dirty marker authorizes one all-or-nothing cleanup sequence.
    // Do not revoke state authority before proving the complete managed build
    // can be removed: otherwise a locked build could survive while the marker
    // and recovery evidence disappear.  Keep dirty last so any later failure
    // blocks automatic fallback.
    if clean_managed_build_directory(build, managed_root).is_err() {
        return false;
    }
    if remove_regular_file_if_present(backup_path).is_err() {
        return false;
    }
    if remove_regular_file_if_present(manifest_path).is_err() {
        return false;
    }
    remove_regular_file_if_present(dirty_path).is_ok()
}

fn sibling_state_path(path: &Path, suffix: &str) -> GateResult<PathBuf> {
    let parent = path.parent().ok_or_else(|| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            "state path has no parent",
        )
    })?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                "state file name is not UTF-8",
            )
        })?;
    if !safe_leaf_name(name) || !safe_leaf_name(suffix) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            "state file name or suffix is unsafe",
        ));
    }
    Ok(parent.join(format!("{name}.{suffix}")))
}

pub(super) fn native_relink_dirty_marker_path(manifest_path: &Path) -> GateResult<PathBuf> {
    sibling_state_path(manifest_path, "dirty")
}

/// Remove a retained dirty marker only after the caller has completed one
/// clean Arduino CLI fallback and committed a newly captured baseline.
pub(super) fn clear_recovered_native_relink_dirty_marker(manifest_path: &Path) -> GateResult<()> {
    let dirty = native_relink_dirty_marker_path(manifest_path)?;
    remove_regular_file_if_present(&dirty)
}

fn combined_checkpoint(control: &NativeRelinkRunControl) -> GateResult<()> {
    control.checkpoint()?;
    super::current_build_cancellation_checkpoint().map_err(|error| {
        NativeRelinkGateError::new(NativeRelinkGateCode::Cancelled, error.to_string())
    })
}

fn append_direct_output(target: &mut String, output: &DirectCommandOutput) {
    const MAX: usize = 2 * 1024 * 1024;
    for bytes in [&output.stdout[..], &output.stderr[..]] {
        if target.len() >= MAX {
            break;
        }
        let remaining = MAX - target.len();
        let text = String::from_utf8_lossy(bytes);
        if text.len() <= remaining {
            target.push_str(&text);
        } else {
            let mut end = remaining.min(text.len());
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            target.push_str(&text[..end]);
            target.push_str("\n[NativeRelink output truncated]\n");
            break;
        }
    }
}

fn not_eligible(error: NativeRelinkGateError) -> NativeRelinkOutcome {
    NativeRelinkOutcome::NotEligible {
        code: error.code,
        reason: error.detail,
    }
}

/// Return bounded top-level manifest sections that changed while comparing a
/// candidate edit with the sealed Release environment.  The source section is
/// intentionally excluded: changing the sketch is the operation this engine
/// is designed to relink.  Keeping the names in the diagnostic makes a failed
/// qualification explainable without exposing source bytes or absolute paths.
fn environment_difference_sections(
    previous: &NativeRelinkManifest,
    observed: &NativeRelinkManifest,
) -> String {
    let Ok(mut previous_value) = serde_json::to_value(previous) else {
        return "manifest-serialization".into();
    };
    let Ok(mut observed_value) = serde_json::to_value(observed) else {
        return "manifest-serialization".into();
    };
    if let (Some(previous_map), Some(observed_map)) = (
        previous_value.as_object_mut(),
        observed_value.as_object_mut(),
    ) {
        // Process generations are deliberately not persisted identities.  A
        // current request still has to pass its generation fence and strong
        // toolchain-key revalidation before any transaction can commit.
        previous_map.remove("toolchainIdentityGeneration");
        observed_map.remove("toolchainIdentityGeneration");
        previous_map.remove("lastSource");
        observed_map.remove("lastSource");
        let mut changed = previous_map
            .iter()
            .filter_map(|(key, previous_section)| {
                (observed_map.get(key) != Some(previous_section)).then_some(key.clone())
            })
            .collect::<Vec<_>>();
        changed.extend(
            observed_map
                .keys()
                .filter(|key| !previous_map.contains_key(*key))
                .cloned(),
        );
        changed.sort();
        changed.dedup();
        if changed.is_empty() {
            return "unknown".into();
        }
        return changed.into_iter().take(12).collect::<Vec<_>>().join(",");
    }
    "manifest-shape".into()
}

fn read_ccdb_contract_for_manifest(
    manifest: &NativeRelinkManifest,
    baseline: &NativeRelinkBaselineInput<'_>,
) -> GateResult<NativeReleaseCcdbContract> {
    let build = canonical_directory(baseline.build_dir)?;
    let ccdb_path = build.join("compile_commands.json");
    let metadata = std::fs::symlink_metadata(&ccdb_path).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::MissingFile,
            format!("cannot inspect retained Release CCDB: {error}"),
        )
    })?;
    if metadata_is_reparse(&metadata)
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > NATIVE_RELINK_CCDB_MAX_BYTES
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbUnsupportedEntry,
            "retained Release CCDB is not a bounded ordinary file",
        ));
    }
    let raw = std::fs::read_to_string(&ccdb_path).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbUnsupportedEntry,
            format!("cannot read retained Release CCDB: {error}"),
        )
    })?;
    if sha256_bytes(raw.as_bytes()) != manifest.ccdb.sha256 {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::DirtyBuild,
            "retained Release CCDB differs from its committed manifest",
        ));
    }
    let entries: Vec<NativeCompileCommand> = serde_json::from_str(&raw).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbUnsupportedEntry,
            format!("cannot parse retained Release CCDB: {error}"),
        )
    })?;
    let old_library_roots = manifest
        .library_roots
        .iter()
        .map(|root| PathBuf::from(&root.canonical_path))
        .collect::<Vec<_>>();
    let mut old_source_roots = baseline.allowed_source_roots.to_vec();
    old_source_roots.extend(old_library_roots.iter().cloned());
    let contract = validate_release_ccdb_contract(
        &entries,
        &build,
        baseline.allowed_working_roots,
        &old_source_roots,
        &old_library_roots,
        baseline.allowed_tool_roots,
    )?;
    if contract.command_graph_sha256 != manifest.ccdb.command_graph_sha256
        || contract.entries.len() != manifest.ccdb.entry_count
        || contract.library_objects.len() != manifest.library_objects.len()
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::DirtyBuild,
            "retained Release CCDB graph differs from its committed manifest",
        ));
    }
    Ok(contract)
}

fn validate_graph_transition_identity(
    previous: &NativeRelinkManifest,
    next: &NativeRelinkManifest,
    previous_ccdb: &NativeReleaseCcdbContract,
    next_ccdb: &NativeReleaseCcdbContract,
) -> GateResult<()> {
    // `build_signature` binds the complete request library set.  A certified
    // dependency transition is therefore expected to change it when an
    // external library (for example MsTimer2) is added or removed.  It is not
    // part of the immutable Core/toolchain identity.  Only admit that change
    // when both values are real signatures and the already-validated complete
    // selected graph also changed; a signature-only drift remains fail-closed.
    let selected_graph_changed = previous.ccdb.command_graph_sha256
        != next.ccdb.command_graph_sha256
        || previous.library_roots != next.library_roots
        || previous.library_objects != next.library_objects
        || previous.include_analysis != next.include_analysis
        || previous_ccdb.library_objects != next_ccdb.library_objects;
    if !is_sha256_hex(&previous.build_signature) || !is_sha256_hex(&next.build_signature) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "graph transition build signature is not a lowercase SHA-256",
        ));
    }
    if previous.build_signature != next.build_signature && !selected_graph_changed {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "build signature changed without a validated dependency graph change",
        ));
    }
    if previous.access_mode != "certified"
        || next.access_mode != "certified"
        || previous.canonical_fqbn != next.canonical_fqbn
        || previous.profile != next.profile
        || previous.cli_version != next.cli_version
        || previous.toolchain_key != next.toolchain_key
        || previous.authorization_key != next.authorization_key
        || previous.project_name != next.project_name
        || previous.canonical_project_dir != next.canonical_project_dir
        || previous.canonical_build_dir != next.canonical_build_dir
        || previous.build_options_sha256 != next.build_options_sha256
        || previous.recipe.property_contract_sha256 != next.recipe.property_contract_sha256
        || previous.recipe.objcopy_eep_sha256 != next.recipe.objcopy_eep_sha256
        || previous.recipe.objcopy_hex_sha256 != next.recipe.objcopy_hex_sha256
        || previous.recipe.size_sha256 != next.recipe.size_sha256
        || previous.core_archive != next.core_archive
        || previous.core_cache_identity != next.core_cache_identity
        || previous_ccdb.core_command_graph_sha256 != next_ccdb.core_command_graph_sha256
        || previous_ccdb.core_objects != next_ccdb.core_objects
        || next.ccdb.command_graph_sha256 != next_ccdb.command_graph_sha256
        || next.ccdb.non_core_non_sketch_entry_count != next_ccdb.library_objects.len()
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "immutable certified AVR Release/Core identity changed during graph transition",
        ));
    }
    Ok(())
}

fn capture_graph_transition_library_trees(roots: &[PathBuf]) -> GateResult<Vec<(PathBuf, String)>> {
    roots
        .iter()
        .map(|root| {
            let canonical = canonical_directory(root)?;
            let digest = hash_bounded_library_tree(&canonical)?;
            Ok((canonical, digest))
        })
        .collect()
}

fn validate_graph_transition_library_trees(proofs: &[(PathBuf, String)]) -> GateResult<()> {
    for (root, expected) in proofs {
        let canonical = canonical_directory(root)?;
        if path_key(&canonical) != path_key(root)
            || hash_bounded_library_tree(&canonical)? != *expected
        {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!(
                    "library tree changed while graph-transition compiler tools were running: {}",
                    root.display()
                ),
            ));
        }
    }
    Ok(())
}

fn is_arduino_translation_unit(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "c" | "cc" | "cpp" | "cxx" | "s"
            )
        })
}

fn graph_transition_library_sources(root: &Path) -> GateResult<BTreeSet<String>> {
    let (root, files) = bounded_library_files(root)?;
    let src = root.join("src");
    let modern_src = match std::fs::symlink_metadata(&src) {
        Ok(metadata) => {
            if metadata_is_reparse(&metadata) || !metadata.is_dir() {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::UnsafeFilesystemEntry,
                    format!(
                        "library src is not an ordinary directory: {}",
                        src.display()
                    ),
                ));
            }
            Some(canonical_directory(&src)?)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                format!("cannot inspect library src layout: {error}"),
            ));
        }
    };
    let utility = root.join("utility");
    let mut sources = BTreeSet::new();
    for file in files
        .into_iter()
        .filter(|file| is_arduino_translation_unit(file))
    {
        let admitted = if let Some(src) = &modern_src {
            file.starts_with(src)
        } else {
            file.parent() == Some(root.as_path()) || file.starts_with(&utility)
        };
        if admitted {
            sources.insert(path_key(&file));
        }
    }
    Ok(sources)
}

fn read_graph_transition_library_properties(root: &Path) -> GateResult<Option<String>> {
    let path = root.join("library.properties");
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if metadata_is_reparse(&metadata) || !metadata.is_file() {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::UnsafeFilesystemEntry,
                    "library.properties is not an ordinary file",
                ));
            }
            Ok(Some(std::fs::read_to_string(&path).map_err(|error| {
                NativeRelinkGateError::new(
                    NativeRelinkGateCode::InvalidManifest,
                    format!("library.properties is unreadable or not UTF-8: {error}"),
                )
            })?))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            format!("cannot inspect library.properties: {error}"),
        )),
    }
}

fn graph_library_name_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn graph_library_property<'a>(properties: &'a str, expected: &str) -> Option<&'a str> {
    properties.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        key.trim()
            .trim_start_matches('\u{feff}')
            .trim()
            .eq_ignore_ascii_case(expected)
            .then(|| value.trim())
    })
}

fn graph_library_dependencies(properties: &str) -> Vec<String> {
    graph_library_property(properties, "depends")
        .into_iter()
        .flat_map(|value| value.split(','))
        .filter_map(|value| {
            let name = value.split('(').next().unwrap_or_default().trim();
            (!name.is_empty()).then(|| graph_library_name_key(name))
        })
        .collect()
}

fn validate_graph_transition_library_source_set(
    roots: &[PathBuf],
    ccdb: &NativeReleaseCcdbContract,
) -> GateResult<()> {
    let properties = roots
        .iter()
        .map(|root| read_graph_transition_library_properties(root))
        .collect::<GateResult<Vec<_>>>()?;
    let identities = roots
        .iter()
        .zip(&properties)
        .map(|(root, properties)| {
            let mut keys = BTreeSet::new();
            if let Some(folder) = root.file_name().and_then(|value| value.to_str()) {
                keys.insert(graph_library_name_key(folder));
            }
            if let Some(name) = properties
                .as_deref()
                .and_then(|text| graph_library_property(text, "name"))
            {
                keys.insert(graph_library_name_key(name));
            }
            keys
        })
        .collect::<Vec<_>>();
    let mut public_headers = BTreeMap::<String, usize>::new();
    for (index, root) in roots.iter().enumerate() {
        let (_, files) = bounded_library_files(root)?;
        for file in files {
            let extension = file
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !matches!(extension.as_str(), "h" | "hh" | "hpp" | "hxx") {
                continue;
            }
            let header = file
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if let Some(previous) = public_headers.insert(header.clone(), index)
                && previous != index
            {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::CcdbAmbiguous,
                    format!("selected library roots expose an ambiguous public header: {header}"),
                ));
            }
        }
    }
    let mut expected_total = 0usize;
    for (index, root) in roots.iter().enumerate() {
        if let Some(properties) = &properties[index] {
            for line in properties.lines() {
                let Some((key, value)) = line.split_once('=') else {
                    continue;
                };
                let key = key
                    .trim()
                    .trim_start_matches('\u{feff}')
                    .trim()
                    .to_ascii_lowercase();
                let value = value.trim();
                let unsupported = match key.as_str() {
                    "dot_a_linkage" | "precompiled" => {
                        !value.is_empty() && !value.eq_ignore_ascii_case("false")
                    }
                    "ldflags" => !value.is_empty(),
                    _ => false,
                };
                if unsupported {
                    return Err(NativeRelinkGateError::new(
                        NativeRelinkGateCode::RecipeMismatch,
                        format!("selected library requires Arduino CLI semantics: {key}"),
                    ));
                }
            }
            for dependency in graph_library_dependencies(properties) {
                let provider_count = identities
                    .iter()
                    .filter(|keys| keys.contains(&dependency))
                    .count();
                if provider_count != 1 {
                    return Err(NativeRelinkGateError::new(
                        NativeRelinkGateCode::CcdbAmbiguous,
                        format!(
                            "declared library dependency has {provider_count} selected providers"
                        ),
                    ));
                }
            }
        }
        let expected = graph_transition_library_sources(root)?;
        expected_total += expected.len();
        let observed = ccdb
            .library_objects
            .iter()
            .filter(|object| object.library_root_index == index)
            .map(|object| path_key(&object.source))
            .collect::<BTreeSet<_>>();
        if expected != observed {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbAmbiguous,
                format!(
                    "next CCDB does not exactly enumerate Arduino translation units for selected library root {index}"
                ),
            ));
        }
    }
    if expected_total != ccdb.library_objects.len() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbAmbiguous,
            "next CCDB library source cardinality differs from the selected library trees",
        ));
    }
    Ok(())
}

fn validate_depfile_selected_library_roots(
    depfile: &Path,
    compile_directory: &Path,
    selected_roots: &[PathBuf],
) -> GateResult<()> {
    let selected = if selected_roots.is_empty() {
        Vec::new()
    } else {
        canonical_roots(selected_roots)?
    };
    let raw = std::fs::read_to_string(depfile).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbUnsupportedEntry,
            format!("cannot re-read committed transaction depfile: {error}"),
        )
    })?;
    let (_, dependencies) = parse_single_rule_depfile(&raw)?;
    for dependency in dependencies {
        let path = resolve_token_path(&dependency.decoded, compile_directory);
        let canonical = canonical_ordinary_file(&path, "committed compiler dependency")?;
        if let Some(library_leaf) = canonical_arduino_library_leaf_for_file(&canonical)? {
            let providers = selected
                .iter()
                .filter(|root| path_key(root) == path_key(&library_leaf))
                .count();
            if providers != 1 {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::CcdbAmbiguous,
                    format!(
                        "compiler selected an unadmitted or ambiguous Arduino library dependency: {}",
                        library_leaf.display()
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn remove_previous_library_outputs(build: &Path) -> GateResult<()> {
    let libraries = build.join("libraries");
    match std::fs::symlink_metadata(&libraries) {
        Ok(metadata) => {
            if metadata_is_reparse(&metadata) || !metadata.is_dir() {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::UnsafeFilesystemEntry,
                    "retained library output root is not an ordinary directory",
                ));
            }
            ensure_ordinary_ancestors(&libraries, build)?;
            std::fs::remove_dir_all(&libraries).map_err(|error| {
                NativeRelinkGateError::new(
                    NativeRelinkGateCode::DirtyBuild,
                    format!("cannot remove previous library object graph: {error}"),
                )
            })?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                format!("cannot inspect previous library object graph: {error}"),
            ));
        }
    }
    std::fs::create_dir(&libraries).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::DirtyBuild,
            format!("cannot recreate empty library object root: {error}"),
        )
    })?;
    canonical_directory(&libraries)?;
    Ok(())
}

fn create_graph_output_parents(
    build: &Path,
    objects: impl IntoIterator<Item = PathBuf>,
) -> GateResult<()> {
    let lexical_build = lexical_absolute_path(build)?;
    let build = canonical_directory(&lexical_build)?;
    let build_key = path_key(&lexical_build);
    for object in objects {
        let lexical = lexical_absolute_path(&object)?;
        let Some(raw_build_root) = lexical
            .ancestors()
            .find(|ancestor| path_key(ancestor) == build_key)
        else {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbOutputOutsideBuild,
                format!("graph output escaped build: {}", object.display()),
            ));
        };
        let relative = lexical.strip_prefix(raw_build_root).map_err(|_| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbOutputOutsideBuild,
                "graph output escaped canonical build",
            )
        })?;
        if relative.as_os_str().is_empty() {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbOutputOutsideBuild,
                "graph output cannot replace the build root",
            ));
        }
        let parent = relative.parent().ok_or_else(|| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                "graph output has no relative parent",
            )
        })?;
        let mut cursor = raw_build_root.to_path_buf();
        for component in parent.components() {
            let Component::Normal(name) = component else {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::InvalidPath,
                    "graph output parent has an unsafe component",
                ));
            };
            cursor.push(name);
            match std::fs::symlink_metadata(&cursor) {
                Ok(metadata) if metadata.is_dir() && !metadata_is_reparse(&metadata) => {}
                Ok(_) => {
                    return Err(NativeRelinkGateError::new(
                        NativeRelinkGateCode::UnsafeFilesystemEntry,
                        format!("graph output parent is unsafe: {}", cursor.display()),
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    std::fs::create_dir(&cursor).map_err(|error| {
                        NativeRelinkGateError::new(
                            NativeRelinkGateCode::DirtyBuild,
                            format!("cannot create graph output parent: {error}"),
                        )
                    })?;
                }
                Err(error) => {
                    return Err(NativeRelinkGateError::new(
                        NativeRelinkGateCode::InvalidPath,
                        format!("cannot inspect graph output parent: {error}"),
                    ));
                }
            }
        }
        let canonical_parent = canonical_directory(&cursor)?;
        if !canonical_parent.starts_with(&build) {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbOutputOutsideBuild,
                format!("graph output parent escaped build: {}", cursor.display()),
            ));
        }
    }
    Ok(())
}

fn commit_graph_transition_library_outputs(
    build: &Path,
    library_transactions: &[(PathBuf, PathBuf, PathBuf, PathBuf)],
) -> GateResult<()> {
    // Capture the validated transaction bytes before mutating the canonical
    // graph.  `atomic_replace_file` moves each file into its Arduino-owned
    // output path; the retained dirty marker makes a partially committed graph
    // unusable and forces full managed-build cleanup before CLI fallback.
    let expected_hashes = library_transactions
        .iter()
        .map(|(transaction_object, transaction_depfile, _, _)| {
            Ok((
                sha256_file(transaction_object)?,
                sha256_file(transaction_depfile)?,
            ))
        })
        .collect::<GateResult<Vec<_>>>()?;

    remove_previous_library_outputs(build)?;
    create_graph_output_parents(
        build,
        library_transactions
            .iter()
            .flat_map(|(_, _, object, depfile)| [object.clone(), depfile.clone()]),
    )?;
    for ((transaction_object, transaction_depfile, object, depfile), (object_hash, depfile_hash)) in
        library_transactions.iter().zip(expected_hashes)
    {
        // Commit object before its depfile.  Until both exist the dirty marker
        // remains authoritative, so no manifest may certify the partial pair.
        commit_transaction_file(transaction_object, object, build)?;
        commit_transaction_file(transaction_depfile, depfile, build)?;
        if sha256_file(object)? != object_hash || sha256_file(depfile)? != depfile_hash {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                "canonical library object/depfile bytes changed during graph commit",
            ));
        }
    }
    Ok(())
}

fn graph_transition_link_tokens(
    recipe_tokens: &[String],
    build: &Path,
    canonical_sketch_object: &Path,
    transaction_sketch_object: &Path,
    transaction_elf: &Path,
) -> GateResult<Vec<String>> {
    let final_elf = command_output_token(recipe_tokens, build)?;
    let tokens = replace_exact_path_token(
        recipe_tokens,
        build,
        canonical_sketch_object,
        transaction_sketch_object,
    )?;
    // Deliberately do not rewrite library object tokens. AVR GCC's LTO link
    // result is sensitive to the input object names. The freshly compiled and
    // validated objects have already been atomically committed to these exact
    // canonical Arduino paths, preserving native link order and byte identity.
    replace_command_output(&tokens, build, transaction_elf).and_then(|tokens| {
        let output = command_output_token(&tokens, build)?;
        if path_key(&output) != path_key(transaction_elf)
            || path_key(&final_elf) == path_key(transaction_elf)
        {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::RecipeMismatch,
                "graph-transition link output rewrite is ambiguous",
            ));
        }
        Ok(tokens)
    })
}

/// Execute a complete certified AVR Release dependency add/remove edit without
/// invoking Arduino CLI. Every compiler output is first prepared and validated
/// below the NativeRelink transaction directory. After all compilers succeed,
/// the selected library graph is committed to its canonical Arduino paths
/// before link so AVR LTO sees the same input names and order as native CLI.
/// The dirty marker makes any partial graph unauthoritative; the ordinary
/// NativeRelink manifest remains the final atomic commit marker. Any uncertainty
/// or mutation failure uses the same full managed-build cleanup contract as
/// sketch-only relink.
pub(super) async fn try_native_relink_graph_transition<FDependency, FSize, FLease>(
    input: NativeRelinkGraphTransitionInput<'_>,
    control: &NativeRelinkRunControl,
    refresh_dependency_signature: FDependency,
    parse_size_summary: FSize,
    final_identity_revalidate: FLease,
) -> NativeRelinkOutcome
where
    FDependency: FnOnce() -> Result<String, String>,
    FSize: Fn(&str) -> Result<Vec<String>, String>,
    FLease: FnOnce() -> Result<(), String>,
{
    let total_started = Instant::now();
    if !matches!(input.compile_intent, super::CompileIntent::CompileOnly)
        || input.force_rebuild
        || input.cache_reset_pending
        || input.attempt != 0
        || input.baseline.access_mode != "certified"
    {
        return NativeRelinkOutcome::NotEligible {
            code: NativeRelinkGateCode::InvalidManifest,
            reason: "NativeRelinkGraphTransition requires certified AVR Release compile-only attempt 0 without force/reset"
                .into(),
        };
    }
    if let Err(error) = validate_graph_transition_include_source(
        input.baseline.source,
        &input.baseline.include_analysis,
    ) {
        return NativeRelinkOutcome::NotEligible {
            code: error.code,
            reason: error.detail,
        };
    }
    if let Err(error) = combined_checkpoint(control) {
        return NativeRelinkOutcome::Cancelled {
            reason: error.detail,
            build_was_cleaned: false,
        };
    }

    let dirty_path = match native_relink_dirty_marker_path(input.manifest_path) {
        Ok(path) => path,
        Err(error) => return not_eligible(error),
    };
    match read_dirty_marker(&dirty_path, input.manifest_path) {
        Ok(None) => {}
        Ok(Some(_)) => {
            let cleaned = cleanup_after_direct_failure(
                input.manifest_path,
                input.backup_path,
                &dirty_path,
                input.baseline.build_dir,
                input.managed_build_root,
            );
            return NativeRelinkOutcome::DirtyFailure {
                code: NativeRelinkGateCode::DirtyBuild,
                reason: "an incomplete NativeRelink graph transaction was found".into(),
                dirty_marker: dirty_path,
                clean_build_required: true,
                build_was_cleaned: cleaned,
            };
        }
        Err(error) => {
            return NativeRelinkOutcome::BlockedByUntrustedMarker {
                code: error.code,
                reason: format!("retained dirty marker was rejected: {}", error.detail),
                dirty_marker: dirty_path,
            };
        }
    }

    let (previous_manifest, previous_manifest_sha256) = match read_manifest(input.manifest_path) {
        Ok(value) => value,
        Err(error) => return not_eligible(error),
    };
    if previous_manifest.access_mode != "certified" {
        return NativeRelinkOutcome::NotEligible {
            code: NativeRelinkGateCode::InvalidManifest,
            reason: "dependency transitions require a certified prior NativeRelink baseline".into(),
        };
    }
    if let Err(error) = validate_manifest_build_state_read_only(&previous_manifest) {
        return not_eligible(error);
    }
    let backup_parent = match input.backup_path.parent() {
        Some(parent) => parent,
        None => {
            return not_eligible(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                "source backup has no parent",
            ));
        }
    };
    let backup =
        match canonical_regular_file_within(input.backup_path, &[backup_parent.to_path_buf()]) {
            Ok(path) => path,
            Err(error) => return not_eligible(error),
        };
    let previous_source = match std::fs::read(&backup) {
        Ok(bytes) => bytes,
        Err(error) => {
            return not_eligible(NativeRelinkGateError::new(
                NativeRelinkGateCode::MissingFile,
                format!("cannot read committed source backup: {error}"),
            ));
        }
    };
    if sha256_bytes(&previous_source) != previous_manifest.last_source.raw_sha256
        || sha256_bytes(input.baseline.source.as_bytes())
            == previous_manifest.last_source.raw_sha256
    {
        return NativeRelinkOutcome::NotEligible {
            code: NativeRelinkGateCode::InvalidManifest,
            reason: "graph transition source backup is invalid or source is unchanged".into(),
        };
    }

    let build = match canonical_directory(input.baseline.build_dir) {
        Ok(path) => path,
        Err(error) => return not_eligible(error),
    };
    let previous_ccdb = match read_ccdb_contract_for_manifest(&previous_manifest, &input.baseline) {
        Ok(contract) => contract,
        Err(error) => return not_eligible(error),
    };
    let next_ccdb = match validate_release_ccdb_graph_transition_contract(
        input.next_ccdb,
        &build,
        input.baseline.allowed_working_roots,
        input.baseline.allowed_source_roots,
        input.baseline.allowed_library_roots,
        input.baseline.allowed_tool_roots,
    ) {
        Ok(contract) => contract,
        Err(error) => return not_eligible(error),
    };
    let library_tree_proofs =
        match capture_graph_transition_library_trees(input.baseline.allowed_library_roots) {
            Ok(proofs) => proofs,
            Err(error) => return not_eligible(error),
        };
    if next_ccdb.core_command_graph_sha256 != previous_ccdb.core_command_graph_sha256
        || next_ccdb.core_objects != previous_ccdb.core_objects
    {
        return NativeRelinkOutcome::NotEligible {
            code: NativeRelinkGateCode::InvalidManifest,
            reason:
                "the next dependency graph does not preserve the exact certified Core command graph"
                    .into(),
        };
    }
    if let Err(error) = validate_graph_transition_library_source_set(
        input.baseline.allowed_library_roots,
        &next_ccdb,
    ) {
        return not_eligible(error);
    }
    let sketch_tokens = match command_tokens(&next_ccdb.entries[next_ccdb.sketch_entry_index]) {
        Ok(tokens) => tokens,
        Err(error) => return not_eligible(error),
    };
    let recipe_contract = match validate_release_recipe_contract_inner(
        NativeReleaseRecipeInput {
            property_contract_sha256: input.baseline.property_contract_sha256,
            combine: input.baseline.combine_recipe,
            objcopy_eep: input.baseline.objcopy_eep_recipe,
            objcopy_hex: input.baseline.objcopy_hex_recipe,
            size: input.baseline.size_recipe,
            build_dir: &build,
            project_elf: &build.join(format!("{}.elf", input.baseline.project_name)),
            project_eep: input.baseline.eep_path,
            project_hex: &build.join(format!("{}.hex", input.baseline.project_name)),
            core_archive: input.baseline.core_archive,
            sketch_object: &next_ccdb.sketch_object,
            library_objects: &next_ccdb
                .library_objects
                .iter()
                .map(|object| object.object.clone())
                .collect::<Vec<_>>(),
            allowed_tool_roots: input.baseline.allowed_tool_roots,
            sketch_compile_tokens: &sketch_tokens,
        },
        true,
    ) {
        Ok(contract) => contract,
        Err(error) => return not_eligible(error),
    };
    if let Err(error) = validate_graph_transition_library_trees(&library_tree_proofs) {
        return not_eligible(error);
    }
    let eligibility_ms = total_started.elapsed().as_millis();

    let run_id = native_relink_run_id();
    let mut dirty_marker = NativeRelinkDirtyMarker {
        schema_version: NATIVE_RELINK_MANIFEST_SCHEMA_VERSION,
        engine_contract: NATIVE_RELINK_ENGINE_CONTRACT.into(),
        run_id: run_id.clone(),
        previous_manifest_sha256,
        stage: "prepared".into(),
        started_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    };
    if let Err(error) = write_dirty_marker(&dirty_path, &dirty_marker) {
        return not_eligible(error);
    }

    let transaction = build.join(format!(".ck-native-relink-{run_id}.txn"));
    let transaction_result: GateResult<(
        CapturedNativeRelinkBaseline,
        String,
        String,
        u64,
        NativeRelinkExecutionTimings,
    )> = async {
        // The dirty marker now authorizes destructive invalidation of the old
        // upload-only state.  Until that marker existed the read-only gate
        // above deliberately preserved a valid prior upload manifest.  The
        // new firmware must never inherit that old authorization.
        remove_stale_compile_only_artifacts(&build)?;
        ensure_no_stale_compile_only_artifacts(&build)?;
        std::fs::create_dir(&transaction).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!("cannot create graph transaction directory: {error}"),
            )
        })?;
        for directory in [transaction.join("sketch"), transaction.join("out")] {
            std::fs::create_dir(&directory).map_err(|error| {
                NativeRelinkGateError::new(
                    NativeRelinkGateCode::DirtyBuild,
                    format!("cannot create graph transaction subdirectory: {error}"),
                )
            })?;
        }
        let transaction = canonical_directory(&transaction)?;
        let transaction_ccdb = transaction.join("out/compile_commands.json");
        let ccdb_bytes = serde_json::to_vec_pretty(input.next_ccdb).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbUnsupportedEntry,
                format!("cannot serialize next dependency graph: {error}"),
            )
        })?;
        atomic_write_regular(&transaction_ccdb, &ccdb_bytes)?;

        let transaction_source =
            transaction
                .join("sketch")
                .join(next_ccdb.sketch_source.file_name().ok_or_else(|| {
                    NativeRelinkGateError::new(
                        NativeRelinkGateCode::InvalidPath,
                        "sketch translation has no file name",
                    )
                })?);
        let transaction_sketch_object = transaction.join("out/sketch.o");
        let transaction_sketch_depfile = transaction_sketch_object.with_extension("d");
        let transaction_elf = transaction.join("out/project.elf");
        let transaction_eep = transaction.join("out/project.eep");
        let transaction_hex = transaction.join("out/project.hex");
        let generated = render_direct_cpp(
            input.baseline.source,
            input.baseline.sketch_ino,
            &input.baseline.include_analysis,
            !input.baseline.allowed_library_roots.is_empty(),
        )?;
        atomic_write_regular(&transaction_source, generated.as_bytes())?;

        update_dirty_stage(&dirty_path, &mut dirty_marker, "compile")?;
        combined_checkpoint(control)?;
        let sketch_entry = &next_ccdb.entries[next_ccdb.sketch_entry_index];
        let sketch_directory = canonical_directory(Path::new(&sketch_entry.directory))?;
        let sketch_depfile = next_ccdb.sketch_object.with_extension("d");
        let mut sketch_compile_tokens = command_tokens(sketch_entry)?;
        sketch_compile_tokens = replace_exact_path_token(
            &sketch_compile_tokens,
            &sketch_directory,
            &next_ccdb.sketch_source,
            &transaction_source,
        )?;
        sketch_compile_tokens = replace_optional_exact_path_token(
            &sketch_compile_tokens,
            &sketch_directory,
            &sketch_depfile,
            &transaction_sketch_depfile,
        )?;
        sketch_compile_tokens = replace_command_output(
            &sketch_compile_tokens,
            &sketch_directory,
            &transaction_sketch_object,
        )?;
        let compile_started = Instant::now();
        let sketch_compile_output = execute_direct_command(
            &sketch_compile_tokens,
            &sketch_directory,
            input.baseline.allowed_tool_roots,
            control,
        )
        .await?;
        let mut dependency_roots = input.baseline.allowed_source_roots.to_vec();
        dependency_roots.extend_from_slice(input.baseline.allowed_library_roots);
        dependency_roots.extend_from_slice(input.baseline.allowed_tool_roots);
        dependency_roots.push(build.clone());
        rewrite_transaction_depfile(
            &transaction_sketch_depfile,
            &sketch_directory,
            &transaction_sketch_object,
            &next_ccdb.sketch_object,
            &transaction_source,
            &next_ccdb.sketch_source,
            &dependency_roots,
        )?;
        validate_depfile_selected_library_roots(
            &transaction_sketch_depfile,
            &sketch_directory,
            input.baseline.allowed_library_roots,
        )?;

        let mut library_transactions = Vec::with_capacity(next_ccdb.library_objects.len());
        let mut compiler_output = String::new();
        append_direct_output(&mut compiler_output, &sketch_compile_output);
        for (index, library) in next_ccdb.library_objects.iter().enumerate() {
            combined_checkpoint(control)?;
            let entry = next_ccdb
                .entries
                .iter()
                .find(|entry| {
                    let directory = Path::new(&entry.directory);
                    path_key(&resolve_token_path(&entry.file, directory))
                        == path_key(&library.source)
                        && command_tokens(entry)
                            .ok()
                            .and_then(|tokens| command_output_token(&tokens, directory).ok())
                            .is_some_and(|output| path_key(&output) == path_key(&library.object))
                })
                .ok_or_else(|| {
                    NativeRelinkGateError::new(
                        NativeRelinkGateCode::CcdbAmbiguous,
                        "next graph lost a validated library compile entry",
                    )
                })?;
            let directory = canonical_directory(Path::new(&entry.directory))?;
            let final_depfile = library.object.with_extension("d");
            let transaction_object = transaction.join(format!("out/library-{index}.o"));
            let transaction_depfile = transaction_object.with_extension("d");
            let mut tokens = command_tokens(entry)?;
            tokens = replace_optional_exact_path_token(
                &tokens,
                &directory,
                &final_depfile,
                &transaction_depfile,
            )?;
            tokens = replace_command_output(&tokens, &directory, &transaction_object)?;
            let output = execute_direct_command(
                &tokens,
                &directory,
                input.baseline.allowed_tool_roots,
                control,
            )
            .await?;
            append_direct_output(&mut compiler_output, &output);
            rewrite_library_transaction_depfile(
                &transaction_depfile,
                &directory,
                &transaction_object,
                &library.object,
                &library.source,
                &dependency_roots,
            )?;
            validate_depfile_selected_library_roots(
                &transaction_depfile,
                &directory,
                input.baseline.allowed_library_roots,
            )?;
            library_transactions.push((
                transaction_object,
                transaction_depfile,
                library.object.clone(),
                final_depfile,
            ));
        }
        let sketch_compile_ms = compile_started.elapsed().as_millis();

        // The compiler outputs and depfiles are now fully validated. Commit
        // only the selected library graph to its canonical Arduino paths
        // while the dirty marker is authoritative. This both excludes every
        // removed/stale library object and preserves native AVR LTO input
        // names. Any failure from this point cleans the entire managed build
        // before the single native CLI fallback.
        combined_checkpoint(control)?;
        validate_graph_transition_library_trees(&library_tree_proofs)?;
        update_dirty_stage(&dirty_path, &mut dirty_marker, "commit-library-graph")?;
        commit_graph_transition_library_outputs(&build, &library_transactions)?;

        update_dirty_stage(&dirty_path, &mut dirty_marker, "link")?;
        let final_elf = build.join(format!("{}.elf", input.baseline.project_name));
        let final_hex = build.join(format!("{}.hex", input.baseline.project_name));
        let link_tokens = graph_transition_link_tokens(
            &recipe_contract.combine_tokens,
            &build,
            &next_ccdb.sketch_object,
            &transaction_sketch_object,
            &transaction_elf,
        )?;
        let link_started = Instant::now();
        let link_output = execute_direct_command(
            &link_tokens,
            &build,
            input.baseline.allowed_tool_roots,
            control,
        )
        .await?;
        append_direct_output(&mut compiler_output, &link_output);
        let lto_link_ms = link_started.elapsed().as_millis();

        update_dirty_stage(&dirty_path, &mut dirty_marker, "objcopy")?;
        let objcopy_started = Instant::now();
        let mut eep_tokens = replace_exact_path_token(
            &recipe_contract.objcopy_eep_tokens,
            &build,
            &final_elf,
            &transaction_elf,
        )?;
        eep_tokens = replace_exact_path_token(
            &eep_tokens,
            &build,
            input.baseline.eep_path,
            &transaction_eep,
        )?;
        let eep_output = execute_direct_command(
            &eep_tokens,
            &build,
            input.baseline.allowed_tool_roots,
            control,
        )
        .await?;
        append_direct_output(&mut compiler_output, &eep_output);
        let mut hex_tokens = replace_exact_path_token(
            &recipe_contract.objcopy_hex_tokens,
            &build,
            &final_elf,
            &transaction_elf,
        )?;
        hex_tokens = replace_exact_path_token(&hex_tokens, &build, &final_hex, &transaction_hex)?;
        let hex_output = execute_direct_command(
            &hex_tokens,
            &build,
            input.baseline.allowed_tool_roots,
            control,
        )
        .await?;
        append_direct_output(&mut compiler_output, &hex_output);
        let objcopy_ms = objcopy_started.elapsed().as_millis();

        update_dirty_stage(&dirty_path, &mut dirty_marker, "size")?;
        let size_started = Instant::now();
        let size_tokens = replace_exact_path_token(
            &recipe_contract.size_tokens,
            &build,
            &final_elf,
            &transaction_elf,
        )?;
        let size_process = execute_direct_command(
            &size_tokens,
            &build,
            input.baseline.allowed_tool_roots,
            control,
        )
        .await?;
        let size_ms = size_started.elapsed().as_millis();
        let mut size_output = String::from_utf8_lossy(&size_process.stdout).into_owned();
        if !size_process.stderr.is_empty() {
            size_output.push_str(&String::from_utf8_lossy(&size_process.stderr));
        }
        let size_summary = parse_size_summary(&size_output).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::ExecutionFailed,
                format!("cannot parse graph-transition AVR size output: {error}"),
            )
        })?;
        if size_summary.is_empty() {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::ExecutionFailed,
                "graph-transition AVR size output produced no resource summary",
            ));
        }

        // A library source/header changing after a compiler read but before
        // capture must never let the manifest seal bytes that differ from the
        // object actually produced by this transaction.
        validate_graph_transition_library_trees(&library_tree_proofs)?;

        // All external tools have succeeded. Commit the remaining fixed
        // outputs. Library objects/depfiles were already committed before link
        // and must not be removed or overwritten here.
        combined_checkpoint(control)?;
        update_dirty_stage(&dirty_path, &mut dirty_marker, "commit-outputs")?;
        let commit_started = Instant::now();
        let committed_ccdb = build.join("compile_commands.json");
        let fixed_outputs: [(&Path, &Path); 7] = [
            (
                transaction_source.as_path(),
                next_ccdb.sketch_source.as_path(),
            ),
            (
                transaction_sketch_object.as_path(),
                next_ccdb.sketch_object.as_path(),
            ),
            (
                transaction_sketch_depfile.as_path(),
                sketch_depfile.as_path(),
            ),
            (transaction_ccdb.as_path(), committed_ccdb.as_path()),
            (transaction_elf.as_path(), final_elf.as_path()),
            (transaction_eep.as_path(), input.baseline.eep_path),
            (transaction_hex.as_path(), final_hex.as_path()),
        ];
        for (source, destination) in fixed_outputs {
            commit_transaction_file(source, destination, &build)?;
        }
        remove_stale_compile_only_artifacts(&build)?;

        let dependency_signature = refresh_dependency_signature().map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                format!("cannot refresh graph-transition dependency signature: {error}"),
            )
        })?;
        if dependency_signature.trim().is_empty() {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                "refreshed graph-transition dependency signature is empty",
            ));
        }
        let artifact_paths = vec![final_elf.clone(), final_hex.clone()];
        let next_baseline = NativeRelinkBaselineInput {
            canonical_fqbn: input.baseline.canonical_fqbn,
            build_signature: input.baseline.build_signature,
            cli_version: input.baseline.cli_version,
            toolchain_key: input.baseline.toolchain_key,
            toolchain_identity_generation: input.baseline.toolchain_identity_generation,
            access_mode: input.baseline.access_mode,
            authorization_key: input.baseline.authorization_key,
            project_name: input.baseline.project_name,
            project_dir: input.baseline.project_dir,
            build_dir: input.baseline.build_dir,
            sketch_ino: input.baseline.sketch_ino,
            build_options: input.baseline.build_options,
            ccdb: input.baseline.ccdb,
            core_archive: input.baseline.core_archive,
            property_contract_sha256: input.baseline.property_contract_sha256,
            combine_recipe: input.baseline.combine_recipe,
            objcopy_eep_recipe: input.baseline.objcopy_eep_recipe,
            objcopy_hex_recipe: input.baseline.objcopy_hex_recipe,
            size_recipe: input.baseline.size_recipe,
            allowed_working_roots: input.baseline.allowed_working_roots,
            allowed_source_roots: input.baseline.allowed_source_roots,
            allowed_library_roots: input.baseline.allowed_library_roots,
            allowed_tool_roots: input.baseline.allowed_tool_roots,
            dependency_content_signature: &dependency_signature,
            library_tree_signature: input.baseline.library_tree_signature,
            include_analysis: input.baseline.include_analysis.clone(),
            source: input.baseline.source,
            normalized_source: input.baseline.normalized_source,
            backup_relative_path: input.baseline.backup_relative_path,
            artifact_paths: &artifact_paths,
            eep_path: input.baseline.eep_path,
            size_summary: &size_summary,
        };
        let captured = capture_native_relink_baseline(next_baseline)?;
        validate_graph_transition_identity(
            &previous_manifest,
            &captured.manifest,
            &previous_ccdb,
            &captured.ccdb_contract,
        )?;
        combined_checkpoint(control)?;
        final_identity_revalidate().map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                format!("final target identity lease changed: {error}"),
            )
        })?;
        // `commit_native_relink_baseline` is the final authority boundary. It
        // writes the subordinate source backup, then seals the complete
        // manifest-bound build state before publishing the manifest. Do not
        // repeat the same library-tree/full-manifest scan here: only the dirty
        // marker and cancellation checkpoint below sit between the lease and
        // that authoritative seal, and neither can mutate the build.
        update_dirty_stage(&dirty_path, &mut dirty_marker, "commit-manifest")?;
        combined_checkpoint(control)?;
        commit_native_relink_baseline(
            &captured,
            input.manifest_path,
            input.backup_path,
            input.baseline.source,
        )?;
        std::fs::remove_dir_all(&transaction).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!("cannot remove committed graph transaction directory: {error}"),
            )
        })?;
        // The transaction directory is part of the dirty build. Keep the
        // marker authoritative until it is gone; otherwise a failed cleanup
        // could expose an apparently committed build with transaction debris.
        remove_regular_file_if_present(&dirty_path)?;
        let commit_ms = commit_started.elapsed().as_millis();
        let warnings = warning_count(&compiler_output);
        Ok((
            captured,
            size_output,
            compiler_output,
            warnings,
            NativeRelinkExecutionTimings {
                eligibility_ms,
                sketch_compile_ms,
                lto_link_ms,
                objcopy_ms,
                size_ms,
                commit_ms,
                total_ms: total_started.elapsed().as_millis(),
            },
        ))
    }
    .await;

    match transaction_result {
        Ok((captured, size_output, compiler_output, warning_count, timings)) => {
            NativeRelinkOutcome::Succeeded {
                manifest: captured.manifest,
                size_output,
                compiler_output,
                warning_count,
                timings,
            }
        }
        Err(error) => {
            let cleaned = cleanup_after_direct_failure(
                input.manifest_path,
                input.backup_path,
                &dirty_path,
                input.baseline.build_dir,
                input.managed_build_root,
            );
            if error.code == NativeRelinkGateCode::Cancelled {
                NativeRelinkOutcome::Cancelled {
                    reason: error.detail,
                    build_was_cleaned: cleaned,
                }
            } else {
                NativeRelinkOutcome::DirtyFailure {
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

/// Attempt the fail-closed AVR Release sketch-only transaction.
///
/// `final_identity_revalidate` is deliberately called after every new output
/// and the new manifest have been prepared, but before the manifest commit
/// marker is atomically replaced.  A `DirtyFailure` requires exactly one clean
/// Arduino CLI fallback.  `Cancelled` must be returned to the user directly.
pub(super) async fn try_native_relink_compile_only<FDependency, FSize, FLease>(
    input: NativeRelinkRunInput<'_>,
    control: &NativeRelinkRunControl,
    refresh_dependency_signature: FDependency,
    parse_size_summary: FSize,
    final_identity_revalidate: FLease,
) -> NativeRelinkOutcome
where
    FDependency: FnOnce() -> Result<String, String>,
    FSize: Fn(&str) -> Result<Vec<String>, String>,
    FLease: FnOnce() -> Result<(), String>,
{
    let total_started = Instant::now();
    if !matches!(input.compile_intent, super::CompileIntent::CompileOnly) {
        return NativeRelinkOutcome::NotEligible {
            code: NativeRelinkGateCode::InvalidManifest,
            reason: "NativeRelinkCompileOnly accepts only CompileIntent::CompileOnly".into(),
        };
    }
    if input.force_rebuild || input.cache_reset_pending {
        let invalidated = invalidate_native_relink_baseline(input.manifest_path, input.backup_path);
        return match invalidated {
            Ok(()) => NativeRelinkOutcome::NotEligible {
                code: NativeRelinkGateCode::InvalidManifest,
                reason: "qualification/cache reset invalidated the NativeRelink baseline".into(),
            },
            Err(error) => NativeRelinkOutcome::DirtyFailure {
                code: error.code,
                reason: error.detail,
                dirty_marker: native_relink_dirty_marker_path(input.manifest_path)
                    .unwrap_or_else(|_| input.manifest_path.with_extension("dirty")),
                clean_build_required: true,
                // Invalidation did not reach its authority-last commit point.
                // Preserve the managed build and forbid automatic fallback;
                // an explicit cache reset can retry after the filesystem
                // problem is resolved.
                build_was_cleaned: false,
            },
        };
    }
    if input.attempt > 0 {
        return NativeRelinkOutcome::NotEligible {
            code: NativeRelinkGateCode::InvalidManifest,
            reason: "force rebuild and fallback attempts must use native Arduino CLI".into(),
        };
    }
    if let Err(error) = combined_checkpoint(control) {
        return NativeRelinkOutcome::Cancelled {
            reason: error.detail,
            build_was_cleaned: false,
        };
    }

    let dirty_path = match native_relink_dirty_marker_path(input.manifest_path) {
        Ok(path) => path,
        Err(error) => return not_eligible(error),
    };
    match read_dirty_marker(&dirty_path, input.manifest_path) {
        Ok(None) => {}
        Ok(Some(_marker)) => {
            let cleaned = cleanup_after_direct_failure(
                input.manifest_path,
                input.backup_path,
                &dirty_path,
                input.baseline.build_dir,
                input.managed_build_root,
            );
            return NativeRelinkOutcome::DirtyFailure {
                code: NativeRelinkGateCode::DirtyBuild,
                reason: "an authenticated incomplete NativeRelink transaction was found".into(),
                dirty_marker: dirty_path,
                clean_build_required: true,
                build_was_cleaned: cleaned,
            };
        }
        Err(error) => {
            // An untrusted marker must not authorize recursive deletion or an
            // automatic native-CLI fallback.  The caller surfaces a blocking
            // diagnostic and waits for an explicit safe cache-reset action.
            return NativeRelinkOutcome::BlockedByUntrustedMarker {
                code: error.code,
                reason: format!("retained dirty marker was rejected: {}", error.detail),
                dirty_marker: dirty_path,
            };
        }
    }

    let (previous_manifest, previous_manifest_sha256) = match read_manifest(input.manifest_path) {
        Ok(value) => value,
        Err(error) => return not_eligible(error),
    };
    let backup_parent = match input.backup_path.parent() {
        Some(value) => value,
        None => {
            return not_eligible(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                "source backup has no parent",
            ));
        }
    };
    let backup =
        match canonical_regular_file_within(input.backup_path, &[backup_parent.to_path_buf()]) {
            Ok(value) => value,
            Err(error) => return not_eligible(error),
        };
    let previous_source = match std::fs::read(&backup) {
        Ok(value) => value,
        Err(error) => {
            return not_eligible(NativeRelinkGateError::new(
                NativeRelinkGateCode::MissingFile,
                format!("cannot read committed source backup: {error}"),
            ));
        }
    };
    if sha256_bytes(&previous_source) != previous_manifest.last_source.raw_sha256
        || input.baseline.backup_relative_path != previous_manifest.last_source.backup_relative_path
    {
        return not_eligible(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidManifest,
            "committed source backup does not match the previous manifest",
        ));
    }

    let observed = match capture_native_relink_baseline(input.baseline.clone()) {
        Ok(value) => value,
        Err(error) => return not_eligible(error),
    };
    let current_source_manifest = observed.manifest.last_source.clone();
    if current_source_manifest.raw_sha256 == previous_manifest.last_source.raw_sha256 {
        return NativeRelinkOutcome::NotEligible {
            code: NativeRelinkGateCode::InvalidManifest,
            reason: "source is unchanged; Exact replay owns this request".into(),
        };
    }
    let mut authenticated_environment = observed.manifest.clone();
    authenticated_environment.last_source = previous_manifest.last_source.clone();
    // The generation is meaningful only inside the active request.  Crossing
    // a desktop restart or a completed package-cache invalidation must not
    // revoke a baseline when the freshly resolved strong toolchain key is
    // unchanged.  `final_identity_revalidate` below still rejects movement
    // during this request before the authority marker is committed.
    authenticated_environment.toolchain_identity_generation =
        previous_manifest.toolchain_identity_generation;
    if authenticated_environment != previous_manifest {
        let changed_sections =
            environment_difference_sections(&previous_manifest, &authenticated_environment);
        return NativeRelinkOutcome::NotEligible {
            code: NativeRelinkGateCode::InvalidManifest,
            reason: format!(
                "Release environment differs from the committed NativeRelink baseline (sections: {changed_sections})"
            ),
        };
    }

    let eligibility_ms = total_started.elapsed().as_millis();
    let run_id = native_relink_run_id();
    let mut dirty_marker = NativeRelinkDirtyMarker {
        schema_version: NATIVE_RELINK_MANIFEST_SCHEMA_VERSION,
        engine_contract: NATIVE_RELINK_ENGINE_CONTRACT.into(),
        run_id: run_id.clone(),
        previous_manifest_sha256,
        stage: "prepared".into(),
        started_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    };
    if let Err(error) = write_dirty_marker(&dirty_path, &dirty_marker) {
        return not_eligible(error);
    }

    let build = match canonical_directory(input.baseline.build_dir) {
        Ok(value) => value,
        Err(error) => {
            let cleaned = cleanup_after_direct_failure(
                input.manifest_path,
                input.backup_path,
                &dirty_path,
                input.baseline.build_dir,
                input.managed_build_root,
            );
            return NativeRelinkOutcome::DirtyFailure {
                code: error.code,
                reason: error.detail,
                dirty_marker: dirty_path,
                clean_build_required: true,
                build_was_cleaned: cleaned,
            };
        }
    };
    let transaction = build.join(format!(".ck-native-relink-{run_id}.txn"));
    let transaction_result: GateResult<(
        CapturedNativeRelinkBaseline,
        String,
        String,
        u64,
        NativeRelinkExecutionTimings,
    )> = async {
        std::fs::create_dir(&transaction).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!("cannot create NativeRelink transaction directory: {error}"),
            )
        })?;
        for directory in [transaction.join("sketch"), transaction.join("out")] {
            std::fs::create_dir(&directory).map_err(|error| {
                NativeRelinkGateError::new(
                    NativeRelinkGateCode::DirtyBuild,
                    format!("cannot create transaction subdirectory: {error}"),
                )
            })?;
        }
        let transaction = canonical_directory(&transaction)?;
        let transaction_source = transaction.join("sketch").join(
            observed
                .ccdb_contract
                .sketch_source
                .file_name()
                .ok_or_else(|| {
                    NativeRelinkGateError::new(
                        NativeRelinkGateCode::InvalidPath,
                        "sketch translation has no file name",
                    )
                })?,
        );
        let transaction_object = transaction.join("out/sketch.o");
        let transaction_depfile = transaction_object.with_extension("d");
        let transaction_elf = transaction.join("out/project.elf");
        let transaction_eep = transaction.join("out/project.eep");
        let transaction_hex = transaction.join("out/project.hex");
        let generated = render_direct_cpp(
            input.baseline.source,
            input.baseline.sketch_ino,
            &input.baseline.include_analysis,
            !input.baseline.allowed_library_roots.is_empty(),
        )?;
        atomic_write_regular(&transaction_source, generated.as_bytes())?;

        update_dirty_stage(&dirty_path, &mut dirty_marker, "compile")?;
        combined_checkpoint(control)?;
        let sketch_entry =
            &observed.ccdb_contract.entries[observed.ccdb_contract.sketch_entry_index];
        let compile_directory = canonical_directory(Path::new(&sketch_entry.directory))?;
        let original_depfile = observed.ccdb_contract.sketch_object.with_extension("d");
        let mut compile_tokens = command_tokens(sketch_entry)?;
        compile_tokens = replace_exact_path_token(
            &compile_tokens,
            &compile_directory,
            &observed.ccdb_contract.sketch_source,
            &transaction_source,
        )?;
        compile_tokens = replace_optional_exact_path_token(
            &compile_tokens,
            &compile_directory,
            &original_depfile,
            &transaction_depfile,
        )?;
        compile_tokens =
            replace_command_output(&compile_tokens, &compile_directory, &transaction_object)?;
        let compile_started = Instant::now();
        let compile_output = execute_direct_command(
            &compile_tokens,
            &compile_directory,
            input.baseline.allowed_tool_roots,
            control,
        )
        .await?;
        let sketch_compile_ms = compile_started.elapsed().as_millis();
        let mut dependency_roots = input.baseline.allowed_source_roots.to_vec();
        dependency_roots.extend_from_slice(input.baseline.allowed_library_roots);
        dependency_roots.extend_from_slice(input.baseline.allowed_tool_roots);
        dependency_roots.push(build.clone());
        rewrite_transaction_depfile(
            &transaction_depfile,
            &compile_directory,
            &transaction_object,
            &observed.ccdb_contract.sketch_object,
            &transaction_source,
            &observed.ccdb_contract.sketch_source,
            &dependency_roots,
        )?;
        validate_depfile_selected_library_roots(
            &transaction_depfile,
            &compile_directory,
            input.baseline.allowed_library_roots,
        )?;

        update_dirty_stage(&dirty_path, &mut dirty_marker, "link")?;
        let final_elf = build.join(format!("{}.elf", input.baseline.project_name));
        let final_hex = build.join(format!("{}.hex", input.baseline.project_name));
        let mut link_tokens = replace_exact_path_token(
            &observed.recipe_contract.combine_tokens,
            &build,
            &observed.ccdb_contract.sketch_object,
            &transaction_object,
        )?;
        link_tokens = replace_command_output(&link_tokens, &build, &transaction_elf)?;
        let link_started = Instant::now();
        let link_output = execute_direct_command(
            &link_tokens,
            &build,
            input.baseline.allowed_tool_roots,
            control,
        )
        .await?;
        let lto_link_ms = link_started.elapsed().as_millis();

        update_dirty_stage(&dirty_path, &mut dirty_marker, "objcopy")?;
        let objcopy_started = Instant::now();
        let mut eep_tokens = replace_exact_path_token(
            &observed.recipe_contract.objcopy_eep_tokens,
            &build,
            &final_elf,
            &transaction_elf,
        )?;
        eep_tokens = replace_exact_path_token(
            &eep_tokens,
            &build,
            input.baseline.eep_path,
            &transaction_eep,
        )?;
        let eep_output = execute_direct_command(
            &eep_tokens,
            &build,
            input.baseline.allowed_tool_roots,
            control,
        )
        .await?;
        let mut hex_tokens = replace_exact_path_token(
            &observed.recipe_contract.objcopy_hex_tokens,
            &build,
            &final_elf,
            &transaction_elf,
        )?;
        hex_tokens = replace_exact_path_token(&hex_tokens, &build, &final_hex, &transaction_hex)?;
        let hex_output = execute_direct_command(
            &hex_tokens,
            &build,
            input.baseline.allowed_tool_roots,
            control,
        )
        .await?;
        let objcopy_ms = objcopy_started.elapsed().as_millis();

        update_dirty_stage(&dirty_path, &mut dirty_marker, "size")?;
        let size_started = Instant::now();
        let size_tokens = replace_exact_path_token(
            &observed.recipe_contract.size_tokens,
            &build,
            &final_elf,
            &transaction_elf,
        )?;
        let size_process = execute_direct_command(
            &size_tokens,
            &build,
            input.baseline.allowed_tool_roots,
            control,
        )
        .await?;
        let size_ms = size_started.elapsed().as_millis();
        let mut size_output = String::from_utf8_lossy(&size_process.stdout).into_owned();
        if !size_process.stderr.is_empty() {
            size_output.push_str(&String::from_utf8_lossy(&size_process.stderr));
        }
        let size_summary = parse_size_summary(&size_output).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::ExecutionFailed,
                format!("cannot parse native AVR size output: {error}"),
            )
        })?;
        if size_summary.is_empty() {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::ExecutionFailed,
                "native AVR size output produced no resource summary",
            ));
        }

        // Validate every candidate before replacing even one committed file.
        let transaction_paths: [&Path; 6] = [
            transaction_source.as_path(),
            transaction_object.as_path(),
            transaction_depfile.as_path(),
            transaction_elf.as_path(),
            transaction_eep.as_path(),
            transaction_hex.as_path(),
        ];
        let transaction_identities = transaction_paths
            .iter()
            .map(|path| content_identity_within(path, &transaction))
            .collect::<GateResult<Vec<_>>>()?;
        combined_checkpoint(control)?;
        update_dirty_stage(&dirty_path, &mut dirty_marker, "commit-outputs")?;
        let commit_started = Instant::now();
        let committed_outputs: [(&Path, &Path); 6] = [
            (
                transaction_source.as_path(),
                observed.ccdb_contract.sketch_source.as_path(),
            ),
            (
                transaction_object.as_path(),
                observed.ccdb_contract.sketch_object.as_path(),
            ),
            (transaction_depfile.as_path(), original_depfile.as_path()),
            (transaction_elf.as_path(), final_elf.as_path()),
            (transaction_eep.as_path(), input.baseline.eep_path),
            (transaction_hex.as_path(), final_hex.as_path()),
        ];
        for (source, destination) in committed_outputs {
            commit_transaction_file(source, destination, &build)?;
        }
        let canonical_paths: [&Path; 6] = [
            observed.ccdb_contract.sketch_source.as_path(),
            observed.ccdb_contract.sketch_object.as_path(),
            original_depfile.as_path(),
            final_elf.as_path(),
            input.baseline.eep_path,
            final_hex.as_path(),
        ];
        remove_stale_compile_only_artifacts(&build)?;
        let dependency_signature = refresh_dependency_signature().map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                format!("cannot refresh dependency signature: {error}"),
            )
        })?;
        if dependency_signature.trim().is_empty() {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                "refreshed dependency signature is empty",
            ));
        }
        let artifact_paths = vec![final_elf.clone(), final_hex.clone()];
        let new_baseline_input = NativeRelinkBaselineInput {
            canonical_fqbn: input.baseline.canonical_fqbn,
            build_signature: input.baseline.build_signature,
            cli_version: input.baseline.cli_version,
            toolchain_key: input.baseline.toolchain_key,
            toolchain_identity_generation: input.baseline.toolchain_identity_generation,
            access_mode: input.baseline.access_mode,
            authorization_key: input.baseline.authorization_key,
            project_name: input.baseline.project_name,
            project_dir: input.baseline.project_dir,
            build_dir: input.baseline.build_dir,
            sketch_ino: input.baseline.sketch_ino,
            build_options: input.baseline.build_options,
            ccdb: input.baseline.ccdb,
            core_archive: input.baseline.core_archive,
            property_contract_sha256: input.baseline.property_contract_sha256,
            combine_recipe: input.baseline.combine_recipe,
            objcopy_eep_recipe: input.baseline.objcopy_eep_recipe,
            objcopy_hex_recipe: input.baseline.objcopy_hex_recipe,
            size_recipe: input.baseline.size_recipe,
            allowed_working_roots: input.baseline.allowed_working_roots,
            allowed_source_roots: input.baseline.allowed_source_roots,
            allowed_library_roots: input.baseline.allowed_library_roots,
            allowed_tool_roots: input.baseline.allowed_tool_roots,
            dependency_content_signature: &dependency_signature,
            library_tree_signature: input.baseline.library_tree_signature,
            include_analysis: input.baseline.include_analysis.clone(),
            source: input.baseline.source,
            normalized_source: input.baseline.normalized_source,
            backup_relative_path: input.baseline.backup_relative_path,
            artifact_paths: &artifact_paths,
            eep_path: input.baseline.eep_path,
            size_summary: &size_summary,
        };
        let captured = capture_native_relink_baseline(new_baseline_input)?;
        // Capture records the canonical output bytes, then this independent
        // transaction binding proves they are still exactly what the tools
        // produced. A separate identical scan immediately after the atomic
        // moves added no authority because neither result was committed.
        validate_content_bindings(&canonical_paths, &build, &transaction_identities)?;
        validate_manifest_transition(&previous_manifest, &captured.manifest)?;
        combined_checkpoint(control)?;
        final_identity_revalidate().map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidManifest,
                format!("final target identity lease changed: {error}"),
            )
        })?;
        // The commit helper below writes the subordinate source backup and
        // then performs the complete post-lease seal: outputs, Core identity,
        // CCDB, depfiles, admitted library bytes and stale upload-only residue
        // are all covered before the manifest becomes authoritative. The
        // transaction identity binding above remains the proof that the
        // captured manifest describes exactly the files produced by this run.
        update_dirty_stage(&dirty_path, &mut dirty_marker, "commit-manifest")?;
        // This is deliberately the last cancellable point before the atomic
        // backup/manifest commit. Cancellation after it belongs to the next
        // request and must not turn an already committed state into fallback.
        combined_checkpoint(control)?;
        commit_native_relink_baseline(
            &captured,
            input.manifest_path,
            input.backup_path,
            input.baseline.source,
        )?;
        std::fs::remove_dir_all(&transaction).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::DirtyBuild,
                format!("cannot remove committed transaction directory: {error}"),
            )
        })?;
        // Keep the dirty marker authoritative until every transaction-local
        // file is gone. If cleanup fails after the manifest commit, the outer
        // failure path invalidates the baseline and clears the whole managed
        // build instead of exposing an apparently clean partial transaction.
        remove_regular_file_if_present(&dirty_path)?;
        let commit_ms = commit_started.elapsed().as_millis();
        let mut compiler_output = String::new();
        for output in [&compile_output, &link_output, &eep_output, &hex_output] {
            append_direct_output(&mut compiler_output, output);
        }
        let warnings = warning_count(&compiler_output);
        Ok((
            captured,
            size_output,
            compiler_output,
            warnings,
            NativeRelinkExecutionTimings {
                eligibility_ms,
                sketch_compile_ms,
                lto_link_ms,
                objcopy_ms,
                size_ms,
                commit_ms,
                total_ms: total_started.elapsed().as_millis(),
            },
        ))
    }
    .await;

    match transaction_result {
        Ok((captured, size_output, compiler_output, warning_count, timings)) => {
            NativeRelinkOutcome::Succeeded {
                manifest: captured.manifest,
                size_output,
                compiler_output,
                warning_count,
                timings,
            }
        }
        Err(error) => {
            let cleaned = cleanup_after_direct_failure(
                input.manifest_path,
                input.backup_path,
                &dirty_path,
                input.baseline.build_dir,
                input.managed_build_root,
            );
            if error.code == NativeRelinkGateCode::Cancelled {
                NativeRelinkOutcome::Cancelled {
                    reason: error.detail,
                    build_was_cleaned: cleaned,
                }
            } else {
                NativeRelinkOutcome::DirtyFailure {
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

fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn safe_leaf_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
}

fn safe_relative_path(value: &str) -> bool {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return false;
    }
    let path = Path::new(value);
    !path.is_absolute()
        && path.components().all(|component| {
            matches!(component, Component::Normal(_))
                && safe_leaf_name(&component.as_os_str().to_string_lossy())
        })
}

fn sha256_framed_strings<'a>(domain: &[u8], values: impl IntoIterator<Item = &'a str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update([0]);
    for value in values {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    hex::encode(hasher.finalize())
}

pub(super) fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    // `std::fs::canonicalize` returns Win32 extended-length spelling while
    // Arduino's CCDB and expanded recipes normally use drive-letter spelling.
    // They name the same file and must compare in one namespace. UNC keeps its
    // leading `//`; ordinary `//?/C:/...` loses only the extended prefix.
    #[cfg(windows)]
    let value = if let Some(rest) = value.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else if let Some(rest) = value.strip_prefix("//?/") {
        rest.to_string()
    } else {
        value
    };
    #[cfg(windows)]
    {
        value.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}

fn metadata_is_reparse(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        let _ = FILE_ATTRIBUTE_REPARSE_POINT;
        false
    }
}

fn lexical_absolute_path(path: &Path) -> GateResult<PathBuf> {
    if !path.is_absolute() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            format!("path is not absolute: {}", path.display()),
        ));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::InvalidPath,
                    format!("path contains parent traversal: {}", path.display()),
                ));
            }
        }
    }
    Ok(normalized)
}

pub(super) fn canonical_directory(path: &Path) -> GateResult<PathBuf> {
    let path = lexical_absolute_path(path)?;
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::MissingFile,
            format!("cannot inspect directory {}: {error}", path.display()),
        )
    })?;
    if metadata_is_reparse(&metadata) || !metadata.is_dir() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::UnsafeFilesystemEntry,
            format!("directory is not an ordinary directory: {}", path.display()),
        ));
    }
    std::fs::canonicalize(&path).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            format!("cannot canonicalize directory {}: {error}", path.display()),
        )
    })
}

fn path_is_within(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

fn ensure_ordinary_ancestors(path: &Path, containing_root: &Path) -> GateResult<()> {
    let relative = path.strip_prefix(containing_root).map_err(|_| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            format!(
                "{} is outside managed root {}",
                path.display(),
                containing_root.display()
            ),
        )
    })?;
    let mut cursor = containing_root.to_path_buf();
    for component in relative.components() {
        cursor.push(component.as_os_str());
        let metadata = std::fs::symlink_metadata(&cursor).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::MissingFile,
                format!("cannot inspect {}: {error}", cursor.display()),
            )
        })?;
        if metadata_is_reparse(&metadata) {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::UnsafeFilesystemEntry,
                format!("reparse/symlink component rejected: {}", cursor.display()),
            ));
        }
    }
    Ok(())
}

fn canonical_roots(roots: &[PathBuf]) -> GateResult<Vec<PathBuf>> {
    if roots.is_empty() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            "no managed roots were supplied",
        ));
    }
    let mut out = Vec::with_capacity(roots.len());
    for root in roots {
        out.push(canonical_directory(root)?);
    }
    out.sort_by_key(|path| path_key(path));
    out.dedup_by(|left, right| path_key(left) == path_key(right));
    Ok(out)
}

pub(super) fn canonical_regular_file_within(path: &Path, roots: &[PathBuf]) -> GateResult<PathBuf> {
    let path = lexical_absolute_path(path)?;
    let lexical_roots = roots
        .iter()
        .map(|root| lexical_absolute_path(root))
        .collect::<GateResult<Vec<_>>>()?;
    let root_keys = lexical_roots
        .iter()
        .map(|root| path_key(root))
        .collect::<BTreeSet<_>>();
    // Locate the managed root using the candidate's own spelling. This makes
    // `C:\...` and canonical `\\?\C:\...` comparable while preserving the
    // original path components for symlink/reparse inspection.
    let Some(lexical_root) = path
        .ancestors()
        .find(|ancestor| root_keys.contains(&path_key(ancestor)))
    else {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::ToolOutsideManagedRoot,
            format!(
                "file is lexically outside managed roots: {}",
                path.display()
            ),
        ));
    };
    // Inspect the spelling supplied by the CCDB/recipe before canonicalizing.
    // Otherwise canonicalization would erase a symlink/junction hop and make a
    // reparse path look like an ordinary target inside the same root.
    ensure_ordinary_ancestors(&path, lexical_root)?;
    let canonical_roots = canonical_roots(roots)?;
    let canonical = std::fs::canonicalize(&path).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::MissingFile,
            format!("cannot canonicalize file {}: {error}", path.display()),
        )
    })?;
    let Some(root) = canonical_roots
        .iter()
        .filter(|root| canonical.starts_with(root))
        .max_by_key(|root| root.components().count())
    else {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::ToolOutsideManagedRoot,
            format!("file escaped managed roots: {}", path.display()),
        ));
    };
    ensure_ordinary_ancestors(&canonical, root)?;
    let metadata = std::fs::symlink_metadata(&canonical).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::MissingFile,
            format!("cannot inspect file {}: {error}", canonical.display()),
        )
    })?;
    if metadata_is_reparse(&metadata) || !metadata.is_file() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::UnsafeFilesystemEntry,
            format!("not an ordinary regular file: {}", canonical.display()),
        ));
    }
    if metadata.len() == 0 {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::EmptyFile,
            format!("file is empty: {}", canonical.display()),
        ));
    }
    Ok(canonical)
}

fn canonical_output_path_within(path: &Path, build_dir: &Path) -> GateResult<PathBuf> {
    let path = lexical_absolute_path(path)?;
    let lexical_build = lexical_absolute_path(build_dir)?;
    let build = canonical_directory(build_dir)?;
    let parent = path.parent().ok_or_else(|| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            format!("output has no parent: {}", path.display()),
        )
    })?;
    let build_key = path_key(&lexical_build);
    let Some(raw_build_root) = parent
        .ancestors()
        .find(|ancestor| path_key(ancestor) == build_key)
    else {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbOutputOutsideBuild,
            format!("output is lexically outside build: {}", path.display()),
        ));
    };
    ensure_ordinary_ancestors(parent, raw_build_root)?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::MissingFile,
            format!(
                "cannot canonicalize output parent {}: {error}",
                parent.display()
            ),
        )
    })?;
    if !canonical_parent.starts_with(&build) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbOutputOutsideBuild,
            format!("output escapes build directory: {}", path.display()),
        ));
    }
    ensure_ordinary_ancestors(&canonical_parent, &build)?;
    let file_name = path.file_name().ok_or_else(|| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            format!("output has no file name: {}", path.display()),
        )
    })?;
    let resolved = canonical_parent.join(file_name);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata_is_reparse(&metadata) || !metadata.is_file() => {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::UnsafeFilesystemEntry,
                format!(
                    "existing output is not an ordinary file: {}",
                    path.display()
                ),
            ));
        }
        Ok(_) => {
            let canonical_existing = std::fs::canonicalize(&path).map_err(|error| {
                NativeRelinkGateError::new(
                    NativeRelinkGateCode::InvalidPath,
                    format!(
                        "cannot canonicalize existing output {}: {error}",
                        path.display()
                    ),
                )
            })?;
            if !canonical_existing.starts_with(&build) {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::CcdbOutputOutsideBuild,
                    format!("existing output resolves outside build: {}", path.display()),
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                format!("cannot inspect output {}: {error}", path.display()),
            ));
        }
    }
    Ok(resolved)
}

fn has_shell_meta(command: &str) -> bool {
    command.contains("&&")
        || command.contains("||")
        || command.contains('|')
        || command.contains('>')
        || command.contains('<')
        || command.contains('\n')
        || command.contains('\r')
}

/// Conservative tokenizer for already-expanded Arduino commands.
///
/// Quotes are removed. Backslash is treated as an ordinary Windows path
/// character; shell escapes and substitutions are not accepted by this lane.
fn tokenize_direct_command(command: &str) -> GateResult<Vec<String>> {
    if command.trim().is_empty() || has_shell_meta(command) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::UnsupportedCommand,
            "command is empty or contains shell metacharacters",
        ));
    }
    if command.contains('{') || command.contains('}') {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::UnresolvedProperty,
            "command contains an unresolved property placeholder",
        ));
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
            continue;
        }
        match character {
            '"' | '\'' => quote = Some(character),
            whitespace if whitespace.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            ordinary => current.push(ordinary),
        }
    }
    if quote.is_some() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::UnsupportedCommand,
            "command contains an unterminated quote",
        ));
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    if tokens.is_empty() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::UnsupportedCommand,
            "command has no executable token",
        ));
    }
    Ok(tokens)
}

pub(super) fn resolve_token_path(token: &str, directory: &Path) -> PathBuf {
    let path = PathBuf::from(token.trim_matches(['"', '\'']));
    if path.is_absolute() {
        path
    } else {
        directory.join(path)
    }
}

fn command_output_token(tokens: &[String], directory: &Path) -> GateResult<PathBuf> {
    let positions = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (token == "-o").then_some(index))
        .collect::<Vec<_>>();
    if positions.len() != 1 || positions[0] + 1 >= tokens.len() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbAmbiguous,
            "compile command must contain exactly one complete -o option",
        ));
    }
    Ok(resolve_token_path(&tokens[positions[0] + 1], directory))
}

fn effective_optimization(tokens: &[String]) -> Option<&str> {
    tokens.iter().rev().find_map(|token| match token.as_str() {
        "-O" | "-O0" | "-O1" | "-O2" | "-O3" | "-Os" | "-Og" | "-Oz" | "-Ofast" => {
            Some(token.as_str())
        }
        _ => None,
    })
}

fn effective_lto(tokens: &[String]) -> Option<bool> {
    tokens.iter().rev().find_map(|token| match token.as_str() {
        "-flto" => Some(true),
        "-fno-lto" => Some(false),
        _ => None,
    })
}

fn tokens_contain_exact_path(tokens: &[String], expected: &Path, directory: &Path) -> bool {
    let expected = path_key(expected);
    tokens
        .iter()
        .filter(|token| !token.starts_with('-'))
        .any(|token| path_key(&resolve_token_path(token, directory)) == expected)
}

fn validate_executable(tokens: &[String], roots: &[PathBuf]) -> GateResult<PathBuf> {
    let mut executable = PathBuf::from(&tokens[0]);
    if !executable.is_absolute() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::UnsupportedCommand,
            format!("tool executable is not absolute: {}", tokens[0]),
        ));
    }
    #[cfg(windows)]
    if !executable.is_file() && executable.extension().is_none() {
        let with_exe = executable.with_extension("exe");
        if with_exe.is_file() {
            executable = with_exe;
        }
    }
    canonical_regular_file_within(&executable, roots)
}

fn command_tokens(entry: &NativeCompileCommand) -> GateResult<Vec<String>> {
    if !entry.arguments.is_empty() {
        if !entry.command.trim().is_empty() {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbAmbiguous,
                "CCDB entry contains both arguments and command",
            ));
        }
        if entry.arguments.iter().any(|token| {
            token.starts_with('@')
                || token.contains('{')
                || token.contains('}')
                || has_shell_meta(token)
        }) {
            return Err(NativeRelinkGateError::new(
                if entry.arguments.iter().any(|token| token.starts_with('@')) {
                    NativeRelinkGateCode::CcdbResponseFileUnsupported
                } else {
                    NativeRelinkGateCode::UnsupportedCommand
                },
                "Phase 1 CCDB arguments contain a response file, placeholder, or shell token",
            ));
        }
        return Ok(entry.arguments.clone());
    }
    Err(NativeRelinkGateError::new(
        NativeRelinkGateCode::CcdbUnsupportedEntry,
        "Phase 1 requires an arguments-form CCDB entry",
    ))
}

/// Validate a native AVR Release CCDB without executing a compiler.
///
/// Phase 1 accepts exactly one sketch object and any number of Core objects.
/// Library/precompiled objects are rejected because CCDB does not prove their
/// final Arduino linker/archive ordering.
pub(super) fn validate_release_ccdb_contract(
    entries: &[NativeCompileCommand],
    build_dir: &Path,
    allowed_working_roots: &[PathBuf],
    allowed_source_roots: &[PathBuf],
    allowed_library_roots: &[PathBuf],
    allowed_tool_roots: &[PathBuf],
) -> GateResult<NativeReleaseCcdbContract> {
    validate_release_ccdb_contract_inner(
        entries,
        build_dir,
        allowed_working_roots,
        allowed_source_roots,
        allowed_library_roots,
        allowed_tool_roots,
        false,
    )
}

fn validate_release_ccdb_graph_transition_contract(
    entries: &[NativeCompileCommand],
    build_dir: &Path,
    allowed_working_roots: &[PathBuf],
    allowed_source_roots: &[PathBuf],
    allowed_library_roots: &[PathBuf],
    allowed_tool_roots: &[PathBuf],
) -> GateResult<NativeReleaseCcdbContract> {
    validate_release_ccdb_contract_inner(
        entries,
        build_dir,
        allowed_working_roots,
        allowed_source_roots,
        allowed_library_roots,
        allowed_tool_roots,
        true,
    )
}

fn planned_library_output_path(path: &Path, directory: &Path, build: &Path) -> GateResult<PathBuf> {
    let resolved = if path.is_absolute() {
        lexical_absolute_path(path)?
    } else {
        lexical_absolute_path(&directory.join(path))?
    };
    let build = canonical_directory(build)?;
    let build_spelling = process_path_token(&build.to_string_lossy()).replace('\\', "/");
    let output_spelling = process_path_token(&resolved.to_string_lossy()).replace('\\', "/");
    let prefix = format!("{build_spelling}/libraries/");
    if output_spelling.len() < prefix.len()
        || !output_spelling[..prefix.len()].eq_ignore_ascii_case(&prefix)
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbOutputOutsideBuild,
            format!(
                "planned library output is not below build/libraries: {}",
                resolved.display()
            ),
        ));
    }
    let relative_text = &output_spelling[prefix.len()..];
    if relative_text.is_empty()
        || !relative_text.ends_with(".o")
        || relative_text.split('/').count() < 2
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbOutputOutsideBuild,
            "planned library output must be a nested .o below build/libraries",
        ));
    }
    let relative =
        Path::new("libraries").join(relative_text.replace('/', std::path::MAIN_SEPARATOR_STR));
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            "planned library output contains an unsafe path component",
        ));
    }
    let normalized = build.join(relative);
    let mut ancestor = normalized.parent();
    let existing = loop {
        let Some(candidate) = ancestor else {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbOutputOutsideBuild,
                "planned library output has no existing build ancestor",
            ));
        };
        match std::fs::symlink_metadata(candidate) {
            Ok(metadata) => break (candidate.to_path_buf(), metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ancestor = candidate.parent();
            }
            Err(error) => {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::InvalidPath,
                    format!("cannot inspect planned library output ancestor: {error}"),
                ));
            }
        }
    };
    if metadata_is_reparse(&existing.1) || !existing.1.is_dir() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::UnsafeFilesystemEntry,
            "planned library output ancestor is not an ordinary directory",
        ));
    }
    let canonical_existing = std::fs::canonicalize(&existing.0).map_err(|error| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::InvalidPath,
            format!("cannot canonicalize planned library output ancestor: {error}"),
        )
    })?;
    if !canonical_existing.starts_with(&build) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbOutputOutsideBuild,
            "planned library output ancestor escaped the build directory",
        ));
    }
    ensure_ordinary_ancestors(&canonical_existing, &build)?;
    match std::fs::symlink_metadata(&normalized) {
        Ok(metadata) if metadata_is_reparse(&metadata) || !metadata.is_file() => {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::UnsafeFilesystemEntry,
                "existing planned library output is not an ordinary file",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                format!("cannot inspect planned library output: {error}"),
            ));
        }
    }
    Ok(normalized)
}

fn validate_release_ccdb_contract_inner(
    entries: &[NativeCompileCommand],
    build_dir: &Path,
    allowed_working_roots: &[PathBuf],
    allowed_source_roots: &[PathBuf],
    allowed_library_roots: &[PathBuf],
    allowed_tool_roots: &[PathBuf],
    allow_planned_library_outputs: bool,
) -> GateResult<NativeReleaseCcdbContract> {
    if entries.is_empty() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbEmpty,
            "Release compilation database is empty",
        ));
    }
    let build = canonical_directory(build_dir)?;
    let canonical_working_roots = canonical_roots(allowed_working_roots)?;
    let canonical_library_roots = canonical_library_roots(allowed_library_roots)?
        .into_iter()
        .map(|(path, _)| path)
        .collect::<Vec<_>>();
    let mut source_bindings = BTreeMap::<String, (String, String)>::new();
    let mut object_owners = BTreeMap::<String, String>::new();
    let mut deduplicated = Vec::with_capacity(entries.len());
    let mut sketch_entry_index = None;
    let mut sketch_source = None;
    let mut sketch_object = None;
    let mut sketch_command_sha256 = None;
    let mut core_entries = 0usize;
    let mut core_objects = Vec::new();
    let mut library_objects = Vec::new();

    for entry in entries {
        let directory = canonical_directory(Path::new(entry.directory.trim()))?;
        if !path_is_within(&directory, &canonical_working_roots) {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::InvalidPath,
                format!(
                    "CCDB working directory is outside managed roots: {}",
                    directory.display()
                ),
            ));
        }
        let tokens = command_tokens(entry)?;
        if tokens.len() < 4 || !tokens.iter().any(|token| token == "-c") {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbUnsupportedEntry,
                format!("CCDB entry is not a direct compile command: {}", entry.file),
            ));
        }
        let compiler_executable = validate_executable(&tokens, allowed_tool_roots)?;
        let raw_source = resolve_token_path(entry.file.trim(), &directory);
        let source = canonical_regular_file_within(&raw_source, allowed_source_roots)?;
        let library_root_index = canonical_library_roots
            .iter()
            .position(|root| source.starts_with(root));
        if !tokens_contain_exact_path(&tokens, &source, &directory) {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbAmbiguous,
                format!(
                    "CCDB command does not contain its declared source: {}",
                    entry.file
                ),
            ));
        }
        let raw_output = command_output_token(&tokens, &directory)?;
        let output = if allow_planned_library_outputs && library_root_index.is_some() {
            planned_library_output_path(&raw_output, &directory, &build)?
        } else {
            canonical_output_path_within(&raw_output, &build)?
        };
        if let Some(declared) = entry
            .output
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            let declared = resolve_token_path(declared, &directory);
            let declared = if allow_planned_library_outputs && library_root_index.is_some() {
                planned_library_output_path(&declared, &directory, &build)?
            } else {
                canonical_output_path_within(&declared, &build)?
            };
            if path_key(&declared) != path_key(&output) {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::CcdbAmbiguous,
                    format!("CCDB output field differs from -o for {}", entry.file),
                ));
            }
        }
        let output = if allow_planned_library_outputs && library_root_index.is_some() {
            output
        } else {
            canonical_regular_file_within(&output, &[build.clone()]).map_err(|error| {
                NativeRelinkGateError::new(
                    error.code,
                    format!(
                        "CCDB object is not a committed regular file: {}",
                        error.detail
                    ),
                )
            })?
        };

        let source_key = path_key(&source);
        let object_key = path_key(&output);
        let command_identity = sha256_framed_strings(
            b"ck-native-release-ccdb-command-v1",
            std::iter::once(path_key(&directory))
                .chain(tokens.iter().cloned())
                .collect::<Vec<_>>()
                .iter()
                .map(String::as_str),
        );
        if let Some((previous_object, previous_command)) = source_bindings.get(&source_key) {
            if previous_object == &object_key && previous_command == &command_identity {
                continue;
            }
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbAmbiguous,
                format!(
                    "one source maps to multiple object/command identities: {}",
                    source.display()
                ),
            ));
        }
        if let Some(previous_source) = object_owners.get(&object_key) {
            if previous_source != &source_key {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::CcdbAmbiguous,
                    format!(
                        "one object has multiple source owners: {}",
                        output.display()
                    ),
                ));
            }
        }

        let relative = output.strip_prefix(&build).map_err(|_| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::CcdbOutputOutsideBuild,
                format!("object escaped canonical build root: {}", output.display()),
            )
        })?;
        let is_sketch = relative.components().next().is_some_and(|component| {
            component
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case("sketch")
        }) && source
            .to_string_lossy()
            .to_ascii_lowercase()
            .ends_with(".ino.cpp");
        let is_core = relative.components().next().is_some_and(|component| {
            component
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case("core")
        });
        if is_sketch {
            if effective_optimization(&tokens) != Some("-Os") {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::OptimizationMismatch,
                    format!(
                        "AVR Release sketch entry is not effectively -Os: {}",
                        entry.file
                    ),
                ));
            }
            if effective_lto(&tokens) != Some(true) {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::LtoMismatch,
                    format!(
                        "AVR Release sketch entry is not effectively -flto: {}",
                        entry.file
                    ),
                ));
            }
            if sketch_entry_index.is_some() {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::MultipleSketchEntries,
                    "Release CCDB has more than one sketch compile unit",
                ));
            }
            sketch_entry_index = Some(deduplicated.len());
            sketch_source = Some(source.clone());
            sketch_object = Some(output.clone());
            sketch_command_sha256 = Some(command_identity.clone());
        } else if is_core {
            core_entries += 1;
            core_objects.push(NativeReleaseCoreObjectContract {
                working_directory: directory.clone(),
                compiler_executable,
                source: source.clone(),
                object: output.clone(),
                depfile: output.with_extension("d"),
                command_sha256: command_identity.clone(),
            });
        } else if let Some(library_root_index) = library_root_index {
            if library_objects.len() >= MAX_LIBRARY_OBJECTS {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::CcdbUnsupportedEntry,
                    "Release CCDB exceeds the bounded library object count",
                ));
            }
            let object_is_library = relative.components().next().is_some_and(|component| {
                component
                    .as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("libraries")
            });
            if !object_is_library {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::CcdbOutputOutsideBuild,
                    format!(
                        "admitted library source does not map to Arduino's libraries object tree: {}",
                        output.display()
                    ),
                ));
            }
            if effective_optimization(&tokens) != Some("-Os")
                || effective_lto(&tokens) != Some(true)
            {
                return Err(NativeRelinkGateError::new(
                    NativeRelinkGateCode::LtoMismatch,
                    format!(
                        "AVR Release library entry is not effectively -Os/-flto: {}",
                        entry.file
                    ),
                ));
            }
            library_objects.push(NativeReleaseLibraryObjectContract {
                library_root_index,
                library_root: canonical_library_roots[library_root_index].clone(),
                working_directory: directory.clone(),
                source: source.clone(),
                object: output.clone(),
                depfile: output.with_extension("d"),
                command_sha256: command_identity.clone(),
            });
        } else {
            return Err(NativeRelinkGateError::new(
                NativeRelinkGateCode::NonCoreObject,
                format!(
                    "Phase 1 refuses a non-Core/non-sketch object: {}",
                    output.display()
                ),
            ));
        }

        source_bindings.insert(source_key.clone(), (object_key.clone(), command_identity));
        object_owners.insert(object_key, source_key);
        deduplicated.push(entry.clone());
    }

    let sketch_entry_index = sketch_entry_index.ok_or_else(|| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::MissingSketchEntry,
            "Release CCDB has no unique .ino.cpp sketch entry",
        )
    })?;
    if core_entries == 0 {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::CcdbUnsupportedEntry,
            "Release CCDB has no Core compile entries",
        ));
    }

    let mut graph_parts = Vec::with_capacity(source_bindings.len() * 3);
    for (source, (object, command)) in &source_bindings {
        graph_parts.push(source.as_str());
        graph_parts.push(object.as_str());
        graph_parts.push(command.as_str());
    }
    let command_graph_sha256 =
        sha256_framed_strings(b"ck-native-release-ccdb-graph-v1", graph_parts);
    let mut core_graph_rows = core_objects
        .iter()
        .map(|object| {
            [
                path_key(&object.compiler_executable),
                path_key(&object.working_directory),
                path_key(&object.source),
                path_key(&object.object),
                object.command_sha256.clone(),
            ]
        })
        .collect::<Vec<_>>();
    core_graph_rows.sort();
    let core_graph_parts = core_graph_rows
        .iter()
        .flat_map(|row| row.iter().map(String::as_str))
        .collect::<Vec<_>>();
    let core_command_graph_sha256 =
        sha256_framed_strings(b"ck-native-release-core-command-graph-v1", core_graph_parts);
    Ok(NativeReleaseCcdbContract {
        entries: deduplicated,
        command_graph_sha256,
        core_command_graph_sha256,
        sketch_entry_index,
        sketch_source: sketch_source.expect("sketch index and source are committed together"),
        sketch_object: sketch_object.expect("sketch index and object are committed together"),
        sketch_command_sha256: sketch_command_sha256
            .expect("sketch index and command are committed together"),
        core_entry_count: core_entries,
        core_objects,
        library_objects,
    })
}

fn validate_recipe_command(command: &str, tool_roots: &[PathBuf]) -> GateResult<Vec<String>> {
    let tokens = tokenize_direct_command(command)?;
    validate_executable(&tokens, tool_roots)?;
    Ok(tokens)
}

fn materialize_combine_recipe(
    recipe: &str,
    build: &Path,
    sketch_object: &Path,
    library_objects: &[PathBuf],
    core_archive: &Path,
) -> GateResult<String> {
    let archive_relative = core_archive.strip_prefix(build).map_err(|_| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::RecipeMismatch,
            "Core archive escaped build while materializing combine recipe",
        )
    })?;
    let archive_relative = archive_relative.to_string_lossy().replace('\\', "/");
    if library_objects.len() > MAX_LIBRARY_OBJECTS {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::RecipeMismatch,
            "combine recipe exceeds the bounded library object count",
        ));
    }
    let mut object_files = Vec::with_capacity(library_objects.len() + 1);
    object_files.push(format!("\"{}\"", sketch_object.to_string_lossy()));
    object_files.extend(
        library_objects
            .iter()
            .map(|object| format!("\"{}\"", object.to_string_lossy())),
    );
    let object_files = object_files.join(" ");
    let mut materialized = recipe
        .replace("{object_files}", &object_files)
        .replace(
            "{archive_file_path}",
            core_archive.to_string_lossy().as_ref(),
        )
        .replace("{archive_file}", &archive_relative);
    // Only the three exact runtime placeholders above are admitted. Property
    // placeholders and unknown future Arduino builder substitutions remain a
    // hard fallback.
    if materialized.contains('{') || materialized.contains('}') {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::UnresolvedProperty,
            "combine recipe contains an unsupported unresolved placeholder",
        ));
    }
    // Preserve a stable owned allocation for the caller and avoid accepting a
    // recipe that consisted only of a placeholder.
    materialized.shrink_to_fit();
    Ok(materialized)
}

fn require_path_token(
    tokens: &[String],
    expected: &Path,
    cwd: &Path,
    label: &str,
) -> GateResult<()> {
    let expected_key = path_key(expected);
    let count = tokens
        .iter()
        .filter(|token| !token.starts_with('-'))
        .filter(|token| path_key(&resolve_token_path(token, cwd)) == expected_key)
        .count();
    if count != 1 {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::RecipeMismatch,
            format!(
                "{label} recipe must reference {} exactly once (observed {count})",
                expected.display()
            ),
        ));
    }
    Ok(())
}

fn require_last_path_token(
    tokens: &[String],
    expected: &Path,
    cwd: &Path,
    label: &str,
) -> GateResult<()> {
    let last = tokens.last().ok_or_else(|| {
        NativeRelinkGateError::new(
            NativeRelinkGateCode::RecipeMismatch,
            format!("{label} recipe has no path tokens"),
        )
    })?;
    if path_key(&resolve_token_path(last, cwd)) != path_key(expected) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::RecipeMismatch,
            format!("{label} is not the final recipe token"),
        ));
    }
    Ok(())
}

/// Authenticate expanded AVR Release link/objcopy/size commands.
pub(super) fn validate_release_recipe_contract(
    input: NativeReleaseRecipeInput<'_>,
) -> GateResult<NativeReleaseRecipeContract> {
    validate_release_recipe_contract_inner(input, false)
}

fn validate_graph_combine_inputs(
    tokens: &[String],
    build: &Path,
    sketch_object: &Path,
    library_objects: &[PathBuf],
    core_archive: &Path,
) -> GateResult<()> {
    let mut expected = BTreeSet::new();
    expected.insert(path_key(sketch_object));
    expected.insert(path_key(core_archive));
    expected.extend(library_objects.iter().map(|path| path_key(path)));
    let mut observed = BTreeMap::<String, usize>::new();
    for token in tokens.iter().filter(|token| !token.starts_with('-')) {
        let path = resolve_token_path(token, build);
        let key = path_key(&path);
        if !key.starts_with(&format!("{}/", path_key(build))) {
            continue;
        }
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if extension == "o" || extension == "a" {
            *observed.entry(key).or_default() += 1;
        }
    }
    if observed.len() != expected.len()
        || expected
            .iter()
            .any(|path| observed.get(path).copied() != Some(1))
        || observed.keys().any(|path| !expected.contains(path))
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::RecipeMismatch,
            "graph-transition combine recipe contains a missing, duplicated, or undeclared build-local .o/.a input",
        ));
    }
    Ok(())
}

fn validate_release_recipe_contract_inner(
    input: NativeReleaseRecipeInput<'_>,
    allow_planned_library_outputs: bool,
) -> GateResult<NativeReleaseRecipeContract> {
    if input.property_contract_sha256.trim().is_empty() {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::RecipeMismatch,
            "Release property contract hash is empty",
        ));
    }
    let build = canonical_directory(input.build_dir)?;
    let elf = canonical_output_path_within(input.project_elf, &build)?;
    let eep = canonical_output_path_within(input.project_eep, &build)?;
    let hex = canonical_output_path_within(input.project_hex, &build)?;
    let archive = canonical_regular_file_within(input.core_archive, &[build.clone()])?;

    if effective_optimization(input.sketch_compile_tokens) != Some("-Os")
        || effective_lto(input.sketch_compile_tokens) != Some(true)
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::LtoMismatch,
            "sketch command is not the native AVR -Os/-flto contract",
        ));
    }

    let materialized_combine = materialize_combine_recipe(
        input.combine,
        &build,
        input.sketch_object,
        input.library_objects,
        &archive,
    )?;
    let combine_tokens = validate_recipe_command(&materialized_combine, input.allowed_tool_roots)?;
    if effective_optimization(&combine_tokens) != Some("-Os")
        || effective_lto(&combine_tokens) != Some(true)
        || !combine_tokens
            .iter()
            .any(|token| token == "-fuse-linker-plugin")
    {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::LtoMismatch,
            "combine recipe does not preserve AVR -Os/-flto linker-plugin semantics",
        ));
    }
    let combine_output = canonical_output_path_within(
        &command_output_token(&combine_tokens, &build).map_err(|error| {
            NativeRelinkGateError::new(
                NativeRelinkGateCode::RecipeMismatch,
                format!("combine output is ambiguous: {}", error.detail),
            )
        })?,
        &build,
    )?;
    if path_key(&combine_output) != path_key(&elf) {
        return Err(NativeRelinkGateError::new(
            NativeRelinkGateCode::RecipeMismatch,
            "combine -o does not name the expected project ELF",
        ));
    }
    require_path_token(&combine_tokens, &elf, &build, "combine output")?;
    require_path_token(&combine_tokens, &archive, &build, "combine archive")?;
    require_path_token(
        &combine_tokens,
        input.sketch_object,
        &build,
        "combine sketch object",
    )?;
    for library_object in input.library_objects {
        let object = if allow_planned_library_outputs {
            planned_library_output_path(library_object, &build, &build)?
        } else {
            canonical_regular_file_within(library_object, &[build.clone()])?
        };
        require_path_token(&combine_tokens, &object, &build, "combine library object")?;
    }
    if allow_planned_library_outputs {
        validate_graph_combine_inputs(
            &combine_tokens,
            &build,
            input.sketch_object,
            input.library_objects,
            &archive,
        )?;
    }

    let objcopy_eep_tokens = validate_recipe_command(input.objcopy_eep, input.allowed_tool_roots)?;
    require_path_token(&objcopy_eep_tokens, &elf, &build, "EEP input")?;
    require_path_token(&objcopy_eep_tokens, &eep, &build, "EEP output")?;
    require_last_path_token(&objcopy_eep_tokens, &eep, &build, "EEP output")?;

    let objcopy_hex_tokens = validate_recipe_command(input.objcopy_hex, input.allowed_tool_roots)?;
    require_path_token(&objcopy_hex_tokens, &elf, &build, "HEX input")?;
    require_path_token(&objcopy_hex_tokens, &hex, &build, "HEX output")?;
    require_last_path_token(&objcopy_hex_tokens, &hex, &build, "HEX output")?;

    let size_tokens = validate_recipe_command(input.size, input.allowed_tool_roots)?;
    require_path_token(&size_tokens, &elf, &build, "size input")?;
    require_last_path_token(&size_tokens, &elf, &build, "size input")?;

    let manifest = NativeRelinkRecipeManifest {
        property_contract_sha256: input.property_contract_sha256.to_string(),
        combine_sha256: sha256_framed_strings(
            b"ck-native-release-combine-v1",
            combine_tokens.iter().map(String::as_str),
        ),
        objcopy_eep_sha256: sha256_framed_strings(
            b"ck-native-release-objcopy-eep-v1",
            objcopy_eep_tokens.iter().map(String::as_str),
        ),
        objcopy_hex_sha256: sha256_framed_strings(
            b"ck-native-release-objcopy-hex-v1",
            objcopy_hex_tokens.iter().map(String::as_str),
        ),
        size_sha256: sha256_framed_strings(
            b"ck-native-release-size-v1",
            size_tokens.iter().map(String::as_str),
        ),
        archive_file: archive
            .strip_prefix(&build)
            .map_err(|_| {
                NativeRelinkGateError::new(
                    NativeRelinkGateCode::RecipeMismatch,
                    "Core archive escaped build root",
                )
            })?
            .to_string_lossy()
            .replace('\\', "/"),
    };
    Ok(NativeReleaseRecipeContract {
        combine_tokens,
        objcopy_eep_tokens,
        objcopy_hex_tokens,
        size_tokens,
        manifest,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LexemeKind {
    Identifier,
    Number,
    Punctuation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Lexeme {
    kind: LexemeKind,
    text: String,
    offset: usize,
}

fn translation_error(
    code: NativeRelinkGateCode,
    detail: impl Into<String>,
) -> NativeRelinkGateError {
    NativeRelinkGateError::new(code, detail)
}

fn is_identifier_start(byte: u8) -> bool {
    byte == b'_' || byte == b'$' || byte.is_ascii_alphabetic()
}

fn is_identifier_continue(byte: u8) -> bool {
    is_identifier_start(byte) || byte.is_ascii_digit()
}

fn line_prefix_is_whitespace(source: &[u8], offset: usize) -> bool {
    let start = source[..offset]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |position| position + 1);
    source[start..offset]
        .iter()
        .all(|byte| byte.is_ascii_whitespace())
}

fn lex_direct_cpp(source: &str) -> GateResult<(Vec<Lexeme>, usize)> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0usize;
    let mut arduino_include_count = 0usize;
    let mut saw_code_token = false;

    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                if bytes[index] == b'\\' && bytes.get(index + 1) == Some(&b'\n') {
                    return Err(translation_error(
                        NativeRelinkGateCode::TranslationUnsupported,
                        "continued line comments are not supported",
                    ));
                }
                index += 1;
            }
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            let start = index;
            index += 2;
            let mut closed = false;
            while index + 1 < bytes.len() {
                if bytes[index] == b'*' && bytes[index + 1] == b'/' {
                    index += 2;
                    closed = true;
                    break;
                }
                index += 1;
            }
            if !closed {
                return Err(translation_error(
                    NativeRelinkGateCode::TranslationMalformed,
                    format!("unterminated block comment at byte {start}"),
                ));
            }
            continue;
        }
        if byte == b'#' && line_prefix_is_whitespace(bytes, index) {
            let start = index;
            let end = bytes[index..]
                .iter()
                .position(|value| *value == b'\n')
                .map_or(bytes.len(), |position| index + position);
            let directive = source[start..end].trim();
            if directive != "#include <Arduino.h>" && directive != "#include \"Arduino.h\"" {
                return Err(translation_error(
                    NativeRelinkGateCode::TranslationUnsupported,
                    format!("unsupported preprocessing directive: {directive}"),
                ));
            }
            if saw_code_token {
                return Err(translation_error(
                    NativeRelinkGateCode::TranslationUnsupported,
                    "Arduino.h include appears after C++ tokens",
                ));
            }
            arduino_include_count += 1;
            index = end;
            continue;
        }
        if byte == b'R' && bytes.get(index + 1) == Some(&b'"') {
            return Err(translation_error(
                NativeRelinkGateCode::TranslationUnsupported,
                "raw string literals are not supported by the Phase 1 lexer",
            ));
        }
        if byte == b'"' || byte == b'\'' {
            let delimiter = byte;
            let start = index;
            index += 1;
            let mut escaped = false;
            let mut closed = false;
            while index < bytes.len() {
                let current = bytes[index];
                if !escaped && current == delimiter {
                    index += 1;
                    closed = true;
                    break;
                }
                if !escaped && current == b'\n' {
                    return Err(translation_error(
                        NativeRelinkGateCode::TranslationMalformed,
                        format!("newline in literal at byte {start}"),
                    ));
                }
                if !escaped && current == b'\\' {
                    escaped = true;
                } else {
                    escaped = false;
                }
                index += 1;
            }
            if !closed {
                return Err(translation_error(
                    NativeRelinkGateCode::TranslationMalformed,
                    format!("unterminated literal at byte {start}"),
                ));
            }
            saw_code_token = true;
            continue;
        }
        if is_identifier_start(byte) {
            let start = index;
            index += 1;
            while index < bytes.len() && is_identifier_continue(bytes[index]) {
                index += 1;
            }
            tokens.push(Lexeme {
                kind: LexemeKind::Identifier,
                text: source[start..index].to_string(),
                offset: start,
            });
            saw_code_token = true;
            continue;
        }
        if byte.is_ascii_digit() {
            let start = index;
            index += 1;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric()
                    || matches!(bytes[index], b'.' | b'_' | b'\''))
            {
                index += 1;
            }
            tokens.push(Lexeme {
                kind: LexemeKind::Number,
                text: source[start..index].to_string(),
                offset: start,
            });
            saw_code_token = true;
            continue;
        }

        let start = index;
        let two = bytes
            .get(index..index + 2)
            .and_then(|slice| std::str::from_utf8(slice).ok());
        let punctuation = match two {
            Some(
                "::" | "->" | "++" | "--" | "==" | "!=" | "<=" | ">=" | "&&" | "||" | "+=" | "-="
                | "*=" | "/=" | "%=" | "<<" | ">>" | "&=" | "|=" | "^=",
            ) => {
                index += 2;
                &source[start..index]
            }
            _ => {
                index += 1;
                &source[start..index]
            }
        };
        if !"{}()[];,:.?~!+-*/%&|^=<>".contains(byte as char) {
            return Err(translation_error(
                NativeRelinkGateCode::TranslationUnsupported,
                format!("unsupported source byte 0x{byte:02x} at {start}"),
            ));
        }
        tokens.push(Lexeme {
            kind: LexemeKind::Punctuation,
            text: punctuation.to_string(),
            offset: start,
        });
        saw_code_token = true;
    }

    if arduino_include_count != 1 {
        return Err(translation_error(
            NativeRelinkGateCode::TranslationUnsupported,
            "Phase 1 requires exactly one literal Arduino.h include",
        ));
    }
    Ok((tokens, arduino_include_count))
}

fn matching_open_paren(tokens: &[Lexeme], close_index: usize) -> Option<usize> {
    let mut depth = 0usize;
    for index in (0..=close_index).rev() {
        match tokens[index].text.as_str() {
            ")" => depth += 1,
            "(" => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn next_nontrivial_token(tokens: &[Lexeme], index: usize) -> Option<usize> {
    (index + 1 < tokens.len()).then_some(index + 1)
}

fn reject_complex_translation_tokens(tokens: &[Lexeme]) -> GateResult<()> {
    const REJECTED_KEYWORDS: &[&str] = &[
        "template",
        "namespace",
        "class",
        "union",
        "operator",
        "concept",
        "requires",
        "co_await",
        "co_yield",
        "co_return",
    ];
    if let Some(token) = tokens.iter().find(|token| {
        token.kind == LexemeKind::Identifier && REJECTED_KEYWORDS.contains(&token.text.as_str())
    }) {
        return Err(translation_error(
            NativeRelinkGateCode::TranslationUnsupported,
            format!(
                "unsupported C++ construct '{}' at byte {}",
                token.text, token.offset
            ),
        ));
    }

    // Detect lambda introducers while preserving ordinary array declarations
    // and indexing. A matching `]` followed by optional `( ... )` and `{` is a
    // lambda; an empty capture immediately followed by `{` is also rejected.
    for (index, token) in tokens
        .iter()
        .enumerate()
        .filter(|(_, token)| token.text == "[")
    {
        let mut depth = 1usize;
        let mut close = None;
        for (cursor, candidate) in tokens.iter().enumerate().skip(index + 1) {
            match candidate.text.as_str() {
                "[" => depth += 1,
                "]" => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(cursor);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(mut cursor) = close else {
            return Err(translation_error(
                NativeRelinkGateCode::TranslationMalformed,
                format!("unmatched '[' at byte {}", token.offset),
            ));
        };
        cursor += 1;
        if tokens
            .get(cursor)
            .is_some_and(|candidate| candidate.text == "(")
        {
            let mut paren = 1usize;
            cursor += 1;
            while cursor < tokens.len() && paren > 0 {
                match tokens[cursor].text.as_str() {
                    "(" => paren += 1,
                    ")" => paren -= 1,
                    _ => {}
                }
                cursor += 1;
            }
        }
        if tokens
            .get(cursor)
            .is_some_and(|candidate| candidate.text == "{")
        {
            return Err(translation_error(
                NativeRelinkGateCode::TranslationUnsupported,
                format!("lambda expression rejected at byte {}", token.offset),
            ));
        }
    }
    Ok(())
}

/// Prove that Arduino's automatic prototype insertion is unnecessary.
///
/// The accepted subset permits data-only structs, globals, and unique free
/// functions. Every call to a user free function must occur after that
/// function's definition. The emitted `.ino.cpp` can therefore contain only
/// `Arduino.h`, a canonical `#line`, and the exact source bytes.
pub(super) fn validate_direct_cpp_translation(
    source: &str,
) -> GateResult<DirectCppTranslationContract> {
    let (tokens, _) = lex_direct_cpp(source)?;
    if tokens.is_empty() {
        return Err(translation_error(
            NativeRelinkGateCode::TranslationMalformed,
            "source has no C++ tokens",
        ));
    }
    reject_complex_translation_tokens(&tokens)?;

    #[derive(Debug, Clone)]
    enum Region {
        Function,
        Struct,
        Initializer,
        Block,
    }

    let mut regions = Vec::<Region>::new();
    let mut definitions = BTreeMap::<String, (usize, usize)>::new();
    let mut definition_name_indices = BTreeSet::<usize>::new();
    let mut last_top_level_delimiter = 0usize;
    let mut paren_depth = 0usize;

    for (index, token) in tokens.iter().enumerate() {
        match token.text.as_str() {
            "(" => {
                if matches!(regions.first(), Some(Region::Struct)) {
                    return Err(translation_error(
                        NativeRelinkGateCode::TranslationUnsupported,
                        "methods/function pointers inside structs are not supported",
                    ));
                }
                paren_depth += 1;
            }
            ")" => {
                paren_depth = paren_depth.checked_sub(1).ok_or_else(|| {
                    translation_error(
                        NativeRelinkGateCode::TranslationMalformed,
                        format!("unmatched ')' at byte {}", token.offset),
                    )
                })?;
            }
            "{" => {
                if regions.is_empty() {
                    let prior = index.checked_sub(1).and_then(|value| tokens.get(value));
                    if prior.is_some_and(|value| value.text == ")") {
                        let close = index - 1;
                        let open = matching_open_paren(&tokens, close).ok_or_else(|| {
                            translation_error(
                                NativeRelinkGateCode::TranslationMalformed,
                                format!("cannot match function '(' before byte {}", token.offset),
                            )
                        })?;
                        let name_index = open.checked_sub(1).ok_or_else(|| {
                            translation_error(
                                NativeRelinkGateCode::TranslationUnsupported,
                                "function definition has no name token",
                            )
                        })?;
                        let name_token = &tokens[name_index];
                        if name_token.kind != LexemeKind::Identifier
                            || matches!(
                                name_token.text.as_str(),
                                "if" | "for" | "while" | "switch" | "catch"
                            )
                        {
                            return Err(translation_error(
                                NativeRelinkGateCode::TranslationUnsupported,
                                format!("unsupported top-level block at byte {}", token.offset),
                            ));
                        }
                        let signature = &tokens[last_top_level_delimiter..index];
                        if signature
                            .iter()
                            .any(|part| matches!(part.text.as_str(), "=" | "[" | "]" | "::"))
                        {
                            return Err(translation_error(
                                NativeRelinkGateCode::TranslationUnsupported,
                                format!(
                                    "complex function declarator rejected for {}",
                                    name_token.text
                                ),
                            ));
                        }
                        if definitions
                            .insert(name_token.text.clone(), (name_token.offset, name_index))
                            .is_some()
                        {
                            return Err(translation_error(
                                NativeRelinkGateCode::AutomaticPrototypeRequired,
                                format!(
                                    "overloaded/duplicate function '{}' rejected",
                                    name_token.text
                                ),
                            ));
                        }
                        definition_name_indices.insert(name_index);
                        regions.push(Region::Function);
                    } else {
                        let header = &tokens[last_top_level_delimiter..index];
                        if header.iter().any(|part| part.text == "struct") {
                            regions.push(Region::Struct);
                        } else if header.iter().any(|part| part.text == "=") {
                            regions.push(Region::Initializer);
                        } else {
                            return Err(translation_error(
                                NativeRelinkGateCode::TranslationUnsupported,
                                format!("unclassified top-level brace at byte {}", token.offset),
                            ));
                        }
                    }
                } else {
                    if matches!(regions.last(), Some(Region::Struct)) {
                        return Err(translation_error(
                            NativeRelinkGateCode::TranslationUnsupported,
                            "nested brace inside a data-only struct is not supported",
                        ));
                    }
                    regions.push(Region::Block);
                }
            }
            "}" => {
                let region = regions.pop().ok_or_else(|| {
                    translation_error(
                        NativeRelinkGateCode::TranslationMalformed,
                        format!("unmatched '}}' at byte {}", token.offset),
                    )
                })?;
                if regions.is_empty() {
                    let _ = region;
                    last_top_level_delimiter = index + 1;
                }
            }
            ";" if regions.is_empty() && paren_depth == 0 => {
                last_top_level_delimiter = index + 1;
            }
            _ => {}
        }
    }
    if !regions.is_empty() || paren_depth != 0 {
        return Err(translation_error(
            NativeRelinkGateCode::TranslationMalformed,
            "source has unbalanced braces or parentheses",
        ));
    }
    for required in ["setup", "loop"] {
        if !definitions.contains_key(required) {
            return Err(translation_error(
                NativeRelinkGateCode::TranslationUnsupported,
                format!("required Arduino function '{required}' is not defined"),
            ));
        }
    }

    let definition_offsets = definitions
        .iter()
        .map(|(name, (offset, _))| (name.clone(), *offset))
        .collect::<HashMap<_, _>>();
    for (index, token) in tokens.iter().enumerate() {
        if token.kind != LexemeKind::Identifier || !definition_offsets.contains_key(&token.text) {
            continue;
        }
        if definition_name_indices.contains(&index)
            || !next_nontrivial_token(&tokens, index).is_some_and(|next| tokens[next].text == "(")
        {
            continue;
        }
        let definition_offset = definition_offsets[&token.text];
        if token.offset < definition_offset && !matches!(token.text.as_str(), "setup" | "loop") {
            return Err(translation_error(
                NativeRelinkGateCode::AutomaticPrototypeRequired,
                format!(
                    "call to '{}' at byte {} precedes its definition at byte {}",
                    token.text, token.offset, definition_offset
                ),
            ));
        }
    }

    let function_names = definitions.keys().cloned().collect::<Vec<_>>();
    Ok(DirectCppTranslationContract {
        contract: DIRECT_CPP_TRANSLATION_CONTRACT,
        source_sha256: sha256_bytes(source.as_bytes()),
        function_names,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    const TEST_ACCESS_MODE: &str = "qualification-probe";
    const TEST_AUTHORIZATION_KEY: &str =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    struct Fixture {
        root: PathBuf,
        tools: PathBuf,
        platform: PathBuf,
        build: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "ck-native-relink-{label}-{}-{nonce}",
                std::process::id()
            ));
            let tools = root.join("tools");
            let platform = root.join("platform");
            let build = root.join("build");
            for directory in [
                &tools,
                &platform,
                &build.join("sketch"),
                &build.join("core"),
                &build.join("txn"),
            ] {
                fs::create_dir_all(directory).expect("fixture directory");
            }
            for tool in ["avr-g++", "avr-gcc", "avr-objcopy", "avr-size"] {
                fs::write(tools.join(tool), format!("fake-{tool}")).expect("fixture tool");
            }
            fs::write(build.join("core/core.a"), b"core-archive").expect("core archive");
            fs::write(
                build.join(CORE_CACHE_IDENTITY_RELATIVE_PATH),
                br#"{"schemaVersion":6,"signature":"fixture","coreArchiveSha256":"fixture"}"#,
            )
            .expect("core cache identity");
            Self {
                root,
                tools,
                platform,
                build,
            }
        }

        fn write_source(&self, relative: &str, bytes: &[u8]) -> PathBuf {
            let path = self.platform.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("source parent");
            }
            fs::write(&path, bytes).expect("source");
            path
        }

        fn sketch_source(&self) -> PathBuf {
            let path = self.build.join("sketch/demo.ino.cpp");
            fs::write(&path, b"#include <Arduino.h>\nvoid setup(){} void loop(){}")
                .expect("sketch source");
            path
        }

        fn command(&self, source: &Path, output: &Path, cpp: bool) -> NativeCompileCommand {
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).expect("object parent");
            }
            fs::write(output, b"compiler-object").expect("compiler object");
            NativeCompileCommand {
                directory: self.root.to_string_lossy().into_owned(),
                arguments: vec![
                    self.tools
                        .join(if cpp { "avr-g++" } else { "avr-gcc" })
                        .to_string_lossy()
                        .into_owned(),
                    "-c".into(),
                    "-g".into(),
                    "-Os".into(),
                    "-flto".into(),
                    source.to_string_lossy().into_owned(),
                    "-o".into(),
                    output.to_string_lossy().into_owned(),
                ],
                command: String::new(),
                file: source.to_string_lossy().into_owned(),
                output: None,
            }
        }

        fn ccdb(&self) -> Vec<NativeCompileCommand> {
            let sketch = self.sketch_source();
            let core = self.write_source("cores/main.cpp", b"void core_main(){}\n");
            vec![
                self.command(&sketch, &self.build.join("sketch/demo.ino.cpp.o"), true),
                self.command(&core, &self.build.join("core/main.cpp.o"), true),
            ]
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    const SIMPLE: &str = r#"#include <Arduino.h>

volatile unsigned long ckCounter = 0;

void setup() {
}

void loop() {
  ckCounter++;
  delay(1);
}
"#;

    const COMPLEX: &str = r#"#include <Arduino.h>

struct CkRollingWindow {
  uint16_t values[32];
  uint8_t cursor;
  uint32_t total;
};
volatile uint32_t ckResult = 0;
CkRollingWindow ckWindow = {{0}, 0, 0};

uint16_t ckMix(uint16_t value, uint8_t round) {
  value = (uint16_t)((value << 3) | (value >> 13));
  return (uint16_t)(value ^ (uint16_t)(0x9e37U + (uint16_t)round * 17U));
}
void ckPush(uint16_t value) {
  ckWindow.total -= ckWindow.values[ckWindow.cursor];
  ckWindow.values[ckWindow.cursor] = value;
  ckWindow.total += value;
  ckWindow.cursor = (uint8_t)((ckWindow.cursor + 1U) & 31U);
}
void setup() { ckPush(1); }
void loop() { ckPush(ckMix((uint16_t)millis(), 2)); delay(1); }
"#;

    const MEDIUM: &str = r#"#include <Arduino.h>
volatile uint16_t ckResult = 0;
uint16_t ckSamples[8] = {3, 5, 8, 13, 21, 34, 55, 89};
uint16_t ckAverage() {
  uint16_t total = 0;
  for (uint8_t index = 0; index < 8U; index++) total += ckSamples[index];
  return total / 8U;
}
void setup() {}
void loop() { ckResult = ckAverage(); delay(1); }
"#;

    fn final_seal_fixture(
        label: &str,
    ) -> (
        Fixture,
        Vec<PathBuf>,
        Vec<NativeRelinkContentIdentity>,
        NativeRelinkFileIdentity,
        NativeRelinkFileIdentity,
    ) {
        let fixture = Fixture::new(label);
        let paths = [
            "sketch/demo.ino.cpp",
            "sketch/demo.ino.cpp.o",
            "sketch/demo.ino.cpp.d",
            "demo.ino.elf",
            "demo.ino.eep",
            "demo.ino.hex",
        ]
        .into_iter()
        .enumerate()
        .map(|(index, relative)| {
            let path = fixture.build.join(relative);
            fs::write(&path, format!("sealed-output-{index}")).expect("final seal output fixture");
            path
        })
        .collect::<Vec<_>>();
        let expected_outputs = paths
            .iter()
            .map(|path| content_identity_within(path, &fixture.build).expect("output identity"))
            .collect::<Vec<_>>();
        let core_archive = file_identity_within(&fixture.build.join("core/core.a"), &fixture.build)
            .expect("core archive identity");
        let core_cache_identity = file_identity_within(
            &fixture.build.join(CORE_CACHE_IDENTITY_RELATIVE_PATH),
            &fixture.build,
        )
        .expect("core cache identity");
        (
            fixture,
            paths,
            expected_outputs,
            core_archive,
            core_cache_identity,
        )
    }

    fn validate_final_seal_fixture(
        fixture: &Fixture,
        paths: &[PathBuf],
        expected_outputs: &[NativeRelinkContentIdentity],
        core_archive: &NativeRelinkFileIdentity,
        core_cache_identity: &NativeRelinkFileIdentity,
    ) -> GateResult<()> {
        let canonical_paths = paths.iter().map(PathBuf::as_path).collect::<Vec<_>>();
        validate_final_commit_state(
            &fixture.build,
            &canonical_paths,
            expected_outputs,
            core_archive,
            core_cache_identity,
        )
    }

    #[test]
    fn final_callback_output_tamper_is_rejected() {
        let (fixture, paths, expected, core, core_identity) =
            final_seal_fixture("final-output-tamper");
        let final_callback = || fs::write(&paths[3], b"callback-tampered-elf");
        final_callback().expect("tamper output in final callback");
        let error = validate_final_seal_fixture(&fixture, &paths, &expected, &core, &core_identity)
            .expect_err("post-lease output tamper must fail closed");
        assert_eq!(error.code, NativeRelinkGateCode::DirtyBuild);
    }

    #[test]
    fn final_callback_core_and_identity_tamper_are_rejected() {
        for (label, relative) in [
            ("final-core-tamper", "core/core.a"),
            (
                "final-core-identity-tamper",
                CORE_CACHE_IDENTITY_RELATIVE_PATH,
            ),
        ] {
            let (fixture, paths, expected, core, core_identity) = final_seal_fixture(label);
            let final_callback = || fs::write(fixture.build.join(relative), b"callback-tamper");
            final_callback().expect("tamper immutable Core state in final callback");
            let error =
                validate_final_seal_fixture(&fixture, &paths, &expected, &core, &core_identity)
                    .expect_err("post-lease Core tamper must fail closed");
            assert_eq!(error.code, NativeRelinkGateCode::DirtyBuild);
        }
    }

    #[test]
    fn final_callback_upload_residue_is_removed_before_commit() {
        let (fixture, paths, expected, core, core_identity) =
            final_seal_fixture("final-upload-residue");
        let stale = [
            fixture.build.join(".ck-upload-artifacts.json"),
            fixture.build.join("demo.ino.with_bootloader.hex"),
            fixture.build.join("demo.ino.with_bootloader.bin"),
        ];
        let final_callback = || {
            for path in &stale {
                fs::write(path, b"upload-only residue")?;
            }
            Ok::<_, std::io::Error>(())
        };
        final_callback().expect("recreate upload residue in final callback");
        validate_final_seal_fixture(&fixture, &paths, &expected, &core, &core_identity)
            .expect("post-lease upload residue should be cleared");
        assert!(stale.iter().all(|path| !path.exists()));
    }

    #[test]
    fn manifest_header_is_strict() {
        let identity = NativeRelinkFileIdentity {
            relative_path: "demo.hex".into(),
            size: 1,
            sha256: "a".repeat(64),
        };
        let core_identity = NativeRelinkFileIdentity {
            relative_path: "core/core.a".into(),
            size: 1,
            sha256: "8".repeat(64),
        };
        let core_cache_identity = NativeRelinkFileIdentity {
            relative_path: CORE_CACHE_IDENTITY_RELATIVE_PATH.into(),
            size: 1,
            sha256: "b".repeat(64),
        };
        let mut manifest = NativeRelinkManifest {
            schema_version: NATIVE_RELINK_MANIFEST_SCHEMA_VERSION,
            engine_contract: NATIVE_RELINK_ENGINE_CONTRACT.into(),
            capability_class: NATIVE_RELINK_CAPABILITY_CLASS.into(),
            canonical_fqbn: "arduino:avr:uno".into(),
            profile: "release".into(),
            build_signature: "sig".into(),
            cli_version: "1.2.3".into(),
            toolchain_key: "tool".into(),
            toolchain_identity_generation: 1,
            access_mode: TEST_ACCESS_MODE.into(),
            authorization_key: TEST_AUTHORIZATION_KEY.into(),
            project_name: "demo.ino".into(),
            canonical_project_dir: "C:/project".into(),
            canonical_build_dir: "C:/build".into(),
            build_options_sha256: "b".repeat(64),
            recipe: NativeRelinkRecipeManifest {
                property_contract_sha256: "c".repeat(64),
                combine_sha256: "d".repeat(64),
                objcopy_eep_sha256: "e".repeat(64),
                objcopy_hex_sha256: "f".repeat(64),
                size_sha256: "0".repeat(64),
                archive_file: "core/core.a".into(),
            },
            ccdb: NativeRelinkCcdbManifest {
                schema: "release-ccdb-v2".into(),
                size: 1,
                sha256: "1".repeat(64),
                entry_count: 2,
                command_graph_sha256: "2".repeat(64),
                sketch_source_relative_path: "sketch/demo.ino.cpp".into(),
                sketch_object_relative_path: "sketch/demo.ino.cpp.o".into(),
                sketch_command_sha256: "3".repeat(64),
                sketch_depfile_sha256: "4".repeat(64),
                non_core_non_sketch_entry_count: 0,
            },
            core_archive: core_identity,
            core_cache_identity,
            dependency_content_signature: "dep".into(),
            library_tree_signature: None,
            library_roots: Vec::new(),
            library_objects: Vec::new(),
            include_analysis: NativeRelinkIncludeManifest {
                headers: vec!["arduino.h".into()],
                preprocessor_fingerprint: "pre".into(),
                synthesis_safe: true,
            },
            translation_contract: DIRECT_CPP_TRANSLATION_CONTRACT.into(),
            last_source: NativeRelinkSourceManifest {
                raw_sha256: "5".repeat(64),
                normalized_sha256: "6".repeat(64),
                backup_relative_path: "backup.ino".into(),
            },
            sketch_object: NativeRelinkFileIdentity {
                relative_path: "sketch/demo.ino.cpp.o".into(),
                size: 1,
                sha256: "9".repeat(64),
            },
            sketch_depfile_sha256: "7".repeat(64),
            outputs: NativeRelinkOutputManifest {
                artifacts: vec![identity.clone()],
                eep: NativeRelinkFileIdentity {
                    relative_path: "demo.eep".into(),
                    size: 1,
                    sha256: "a".repeat(64),
                },
                size_summary: vec!["Sketch uses 1 bytes".into()],
            },
        };
        manifest.validate_header().expect("valid header");
        let valid_manifest = manifest.clone();
        manifest.access_mode = "disabled".into();
        assert_eq!(
            manifest.validate_header().unwrap_err().code,
            NativeRelinkGateCode::InvalidManifest
        );
        manifest = valid_manifest.clone();
        manifest.authorization_key = "not-a-sha256".into();
        assert_eq!(
            manifest.validate_header().unwrap_err().code,
            NativeRelinkGateCode::InvalidManifest
        );
        let mut cross_authorization = valid_manifest.clone();
        cross_authorization.access_mode = "certified".into();
        cross_authorization.authorization_key = "c".repeat(64);
        assert_eq!(
            validate_manifest_transition(&valid_manifest, &cross_authorization)
                .unwrap_err()
                .code,
            NativeRelinkGateCode::InvalidManifest,
            "qualification-probe and certified baselines must never be interchangeable"
        );
        manifest = valid_manifest;
        manifest.profile = "quick-fast".into();
        assert_eq!(
            manifest.validate_header().unwrap_err().code,
            NativeRelinkGateCode::InvalidManifest
        );
    }

    #[test]
    fn manifest_rejects_bad_hash_unsafe_relative_path_and_duplicate_artifact() {
        let identity = NativeRelinkFileIdentity {
            relative_path: "demo.hex".into(),
            size: 1,
            sha256: "a".repeat(64),
        };
        let base = || NativeRelinkManifest {
            schema_version: NATIVE_RELINK_MANIFEST_SCHEMA_VERSION,
            engine_contract: NATIVE_RELINK_ENGINE_CONTRACT.into(),
            capability_class: NATIVE_RELINK_CAPABILITY_CLASS.into(),
            canonical_fqbn: "arduino:avr:uno".into(),
            profile: "release".into(),
            build_signature: "sig".into(),
            cli_version: "1.2.3".into(),
            toolchain_key: "tool".into(),
            toolchain_identity_generation: 1,
            access_mode: TEST_ACCESS_MODE.into(),
            authorization_key: TEST_AUTHORIZATION_KEY.into(),
            project_name: "demo.ino".into(),
            canonical_project_dir: std::env::temp_dir().to_string_lossy().into_owned(),
            canonical_build_dir: std::env::temp_dir().to_string_lossy().into_owned(),
            build_options_sha256: "b".repeat(64),
            recipe: NativeRelinkRecipeManifest {
                property_contract_sha256: "c".repeat(64),
                combine_sha256: "d".repeat(64),
                objcopy_eep_sha256: "e".repeat(64),
                objcopy_hex_sha256: "f".repeat(64),
                size_sha256: "0".repeat(64),
                archive_file: "core/core.a".into(),
            },
            ccdb: NativeRelinkCcdbManifest {
                schema: "release-ccdb-v2".into(),
                size: 1,
                sha256: "1".repeat(64),
                entry_count: 2,
                command_graph_sha256: "2".repeat(64),
                sketch_source_relative_path: "sketch/demo.ino.cpp".into(),
                sketch_object_relative_path: "sketch/demo.ino.cpp.o".into(),
                sketch_command_sha256: "3".repeat(64),
                sketch_depfile_sha256: "4".repeat(64),
                non_core_non_sketch_entry_count: 0,
            },
            core_archive: NativeRelinkFileIdentity {
                relative_path: "core/core.a".into(),
                size: 1,
                sha256: "8".repeat(64),
            },
            core_cache_identity: NativeRelinkFileIdentity {
                relative_path: CORE_CACHE_IDENTITY_RELATIVE_PATH.into(),
                size: 1,
                sha256: "b".repeat(64),
            },
            dependency_content_signature: "dep".into(),
            library_tree_signature: None,
            library_roots: Vec::new(),
            library_objects: Vec::new(),
            include_analysis: NativeRelinkIncludeManifest {
                headers: vec!["arduino.h".into()],
                preprocessor_fingerprint: "pre".into(),
                synthesis_safe: true,
            },
            translation_contract: DIRECT_CPP_TRANSLATION_CONTRACT.into(),
            last_source: NativeRelinkSourceManifest {
                raw_sha256: "5".repeat(64),
                normalized_sha256: "6".repeat(64),
                backup_relative_path: "backup.ino".into(),
            },
            sketch_object: NativeRelinkFileIdentity {
                relative_path: "sketch/demo.ino.cpp.o".into(),
                size: 1,
                sha256: "9".repeat(64),
            },
            sketch_depfile_sha256: "7".repeat(64),
            outputs: NativeRelinkOutputManifest {
                artifacts: vec![identity.clone()],
                eep: NativeRelinkFileIdentity {
                    relative_path: "demo.eep".into(),
                    size: 1,
                    sha256: "a".repeat(64),
                },
                size_summary: vec!["Sketch uses 1 bytes".into()],
            },
        };

        let mut bad_hash = base();
        bad_hash.build_options_sha256 = "ABC".into();
        assert_eq!(
            bad_hash.validate_header().unwrap_err().code,
            NativeRelinkGateCode::InvalidManifest
        );
        let mut traversal = base();
        traversal.last_source.backup_relative_path = "../backup.ino".into();
        assert_eq!(
            traversal.validate_header().unwrap_err().code,
            NativeRelinkGateCode::InvalidManifest
        );
        let mut duplicate = base();
        duplicate.outputs.artifacts.push(identity);
        assert_eq!(
            duplicate.validate_header().unwrap_err().code,
            NativeRelinkGateCode::InvalidManifest
        );
    }

    #[test]
    fn portable_sequence_sources_pass_restricted_translation() {
        for source in [SIMPLE, COMPLEX, MEDIUM, SIMPLE] {
            let contract = validate_direct_cpp_translation(source).expect("portable source");
            assert_eq!(contract.contract, DIRECT_CPP_TRANSLATION_CONTRACT);
            assert!(contract.function_names.contains(&"setup".to_string()));
            assert!(contract.function_names.contains(&"loop".to_string()));
        }
    }

    #[test]
    fn ck_core_only_source_without_explicit_arduino_header_is_injected_safely() {
        let source = format!(
            "const uint8_t ckPins[] = {{2, 3, 4}}; {}\n\
             void setup() {{\n  Serial.begin(115200);\n  pinMode(ckPins[0], OUTPUT);\n}} {}\n\
             void loop() {{\n  digitalWrite(ckPins[0], HIGH);\n}}\n",
            ck_begin_marker("io_pin_group", "definition"),
            ck_end_marker()
        );
        let analysis = NativeRelinkIncludeManifest {
            headers: vec!["arduino.h".into()],
            preprocessor_fingerprint: "core-only-no-directives".into(),
            synthesis_safe: true,
        };
        let plan = validate_native_relink_translation(&source, &analysis, false)
            .expect("real CK core-only source does not need Arduino prototypes");
        assert_eq!(
            plan.contract,
            DIRECT_CPP_IMPLICIT_ARDUINO_TRANSLATION_CONTRACT
        );
        assert!(plan.inject_arduino_header);

        let rendered = render_direct_cpp(&source, Path::new("C:/CK/demo.ino"), &analysis, false)
            .expect("implicit Arduino header translation");
        assert!(rendered.starts_with("#include <Arduino.h>\n#line 1 \""));
        assert_eq!(rendered.matches("#include <Arduino.h>").count(), 1);
        assert!(rendered.contains("Serial.begin(115200)"));
        assert!(rendered.contains("const uint8_t ckPins[]"));

        let explicit = validate_native_relink_translation(SIMPLE, &analysis, false)
            .expect("explicit Arduino include keeps the existing contract");
        assert_eq!(explicit.contract, DIRECT_CPP_TRANSLATION_CONTRACT);
        assert!(!explicit.inject_arduino_header);

        let directive = "#define CK_PIN 2\nvoid setup(){}\nvoid loop(){}\n";
        assert_eq!(
            validate_native_relink_translation(directive, &analysis, false)
                .unwrap_err()
                .code,
            NativeRelinkGateCode::TranslationUnsupported
        );
    }

    #[test]
    fn automatic_prototype_and_overload_cases_fail_closed() {
        let forward = r#"#include <Arduino.h>
void setup() { helper(); }
void helper() {}
void loop() {}
"#;
        assert_eq!(
            validate_direct_cpp_translation(forward).unwrap_err().code,
            NativeRelinkGateCode::AutomaticPrototypeRequired
        );
        let overload = r#"#include <Arduino.h>
int helper(int value) { return value; }
double helper(double value) { return value; }
void setup() {}
void loop() {}
"#;
        assert_eq!(
            validate_direct_cpp_translation(overload).unwrap_err().code,
            NativeRelinkGateCode::AutomaticPrototypeRequired
        );
    }

    #[test]
    fn complex_cpp_and_preprocessor_forms_fail_closed() {
        for source in [
            "#include <Arduino.h>\ntemplate<class T> T f(T v){return v;}\nvoid setup(){}\nvoid loop(){}\n",
            "#include <Arduino.h>\nvoid setup(){auto x=[](){return 1;};}\nvoid loop(){}\n",
            "#include HEADER\nvoid setup(){}\nvoid loop(){}\n",
            "#include <Arduino.h>\n#if X\n#endif\nvoid setup(){}\nvoid loop(){}\n",
            "#include <Arduino.h>\nclass C { void f(){}; };\nvoid setup(){}\nvoid loop(){}\n",
            "#include <Arduino.h>\nconst char* x=R\"(raw)\";\nvoid setup(){}\nvoid loop(){}\n",
        ] {
            assert!(validate_direct_cpp_translation(source).is_err(), "{source}");
        }
    }

    #[test]
    fn malformed_source_fails_closed() {
        for source in [
            "#include <Arduino.h>\nvoid setup(){\nvoid loop(){}\n",
            "#include <Arduino.h>\n/* no close\nvoid setup(){}\nvoid loop(){}\n",
            "#include <Arduino.h>\nconst char* x=\"no close;\nvoid setup(){}\nvoid loop(){}\n",
        ] {
            assert_eq!(
                validate_direct_cpp_translation(source).unwrap_err().code,
                NativeRelinkGateCode::TranslationMalformed
            );
        }
    }

    #[test]
    fn atomic_replace_failure_preserves_previous_marker_and_removes_temporary() {
        let fixture = Fixture::new("atomic-failure");
        let marker = fixture.root.join("native-relink.json");
        fs::write(&marker, b"previous-commit").expect("old marker");
        let error = atomic_write_regular_with(&marker, b"new-commit", |_source, _destination| {
            Err(std::io::Error::other("injected replacement failure"))
        })
        .expect_err("replace failure must escape");
        assert_eq!(error.code, NativeRelinkGateCode::InvalidPath);
        assert_eq!(
            fs::read(&marker).expect("old marker remains"),
            b"previous-commit"
        );
        let leftovers = fs::read_dir(&fixture.root)
            .expect("state directory")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains("ck-native-relink")
            })
            .count();
        assert_eq!(leftovers, 0, "failed atomic write left a temporary file");
    }

    #[test]
    fn retained_dirty_marker_is_bounded_structured_and_engine_bound() {
        let fixture = Fixture::new("dirty-structure");
        let manifest = fixture.root.join("native-relink.json");
        let dirty = native_relink_dirty_marker_path(&manifest).expect("dirty path");
        let committed = complete_core_only_manifest(&fixture);
        let manifest_bytes = serde_json::to_vec(&committed).expect("manifest JSON");
        fs::write(&manifest, &manifest_bytes).expect("committed manifest");
        let marker = NativeRelinkDirtyMarker {
            schema_version: NATIVE_RELINK_MANIFEST_SCHEMA_VERSION,
            engine_contract: NATIVE_RELINK_ENGINE_CONTRACT.into(),
            run_id: "1234-5678-9".into(),
            previous_manifest_sha256: sha256_bytes(&manifest_bytes),
            stage: "commit-outputs".into(),
            started_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_millis(),
        };
        write_dirty_marker(&dirty, &marker).expect("valid dirty marker");
        assert_eq!(
            read_dirty_marker(&dirty, &manifest)
                .expect("structured marker")
                .expect("present marker")
                .run_id,
            marker.run_id
        );

        let mut forged = serde_json::to_value(&marker).expect("marker JSON");
        forged["stage"] = serde_json::Value::String("arbitrary-delete".into());
        forged["unexpected"] = serde_json::Value::Bool(true);
        fs::write(&dirty, serde_json::to_vec(&forged).expect("forged JSON"))
            .expect("forged marker");
        assert!(read_dirty_marker(&dirty, &manifest).is_err());

        fs::remove_file(&dirty).expect("remove forged marker");
        fs::create_dir(&dirty).expect("directory spoof");
        assert_eq!(
            read_dirty_marker(&dirty, &manifest).unwrap_err().code,
            NativeRelinkGateCode::UnsafeFilesystemEntry
        );
    }

    #[cfg(windows)]
    #[test]
    fn locked_build_cleanup_failure_preserves_dirty_marker() {
        use std::fs::OpenOptions;
        use std::os::windows::fs::OpenOptionsExt;

        let fixture = Fixture::new("locked-cleanup");
        let manifest = fixture.root.join("native-relink.json");
        let backup = fixture.root.join("native-source.ino");
        let dirty = fixture.root.join("native-relink.json.dirty");
        let locked = fixture.build.join("locked.bin");
        fs::write(&manifest, b"manifest").expect("manifest");
        fs::write(&backup, b"backup").expect("backup");
        fs::write(&dirty, b"dirty").expect("dirty marker");
        fs::write(&locked, b"locked").expect("locked build file");
        let held = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&locked)
            .expect("deny-delete handle");

        assert!(!cleanup_after_direct_failure(
            &manifest,
            &backup,
            &dirty,
            &fixture.build,
            &fixture.root,
        ));
        assert!(
            dirty.exists(),
            "failed build cleanup must retain dirty marker"
        );
        assert!(fixture.build.exists(), "locked dirty build must remain");
        assert!(
            manifest.exists(),
            "failed build cleanup must preserve manifest authority"
        );
        assert!(
            backup.exists(),
            "failed build cleanup must preserve the committed source backup"
        );

        drop(held);
        assert!(cleanup_after_direct_failure(
            &manifest,
            &backup,
            &dirty,
            &fixture.build,
            &fixture.root,
        ));
        assert!(!dirty.exists());
        assert!(!fixture.build.exists());
    }

    #[test]
    fn failed_build_cleanup_preserves_manifest_backup_and_dirty_authority() {
        let fixture = Fixture::new("invalid-managed-root-cleanup");
        let manifest = fixture.root.join("native-relink.json");
        let backup = fixture.root.join("native-source.ino");
        let dirty = fixture.root.join("native-relink.json.dirty");
        let wrong_managed_root = fixture.root.join("other-managed-root");
        fs::create_dir(&wrong_managed_root).expect("wrong managed root");
        for path in [&manifest, &backup, &dirty] {
            fs::write(path, b"state").expect("transaction state");
        }

        assert!(!cleanup_after_direct_failure(
            &manifest,
            &backup,
            &dirty,
            &fixture.build,
            &wrong_managed_root,
        ));
        assert!(fixture.build.exists(), "untrusted build root must remain");
        assert!(manifest.exists(), "manifest authority must remain");
        assert!(backup.exists(), "source backup must remain");
        assert!(dirty.exists(), "dirty marker must remain authoritative");
    }

    #[test]
    fn cleanup_removes_build_before_state_and_keeps_dirty_on_state_failure() {
        let fixture = Fixture::new("ordered-state-cleanup");
        let manifest = fixture.root.join("native-relink.json");
        let backup = fixture.root.join("native-source.ino");
        let dirty = fixture.root.join("native-relink.json.dirty");
        fs::write(&manifest, b"manifest").expect("manifest");
        fs::create_dir(&backup).expect("unsafe backup entry");
        fs::write(&dirty, b"dirty").expect("dirty marker");

        assert!(!cleanup_after_direct_failure(
            &manifest,
            &backup,
            &dirty,
            &fixture.build,
            &fixture.root,
        ));
        assert!(
            !fixture.build.exists(),
            "managed build must be completely removed before state cleanup"
        );
        assert!(backup.is_dir(), "failed backup leaf must remain untouched");
        assert!(
            manifest.exists(),
            "manifest removal must not run after backup removal fails"
        );
        assert!(dirty.exists(), "dirty marker must always be removed last");

        fs::remove_dir(&backup).expect("remove unsafe backup fixture");
        fs::write(&backup, b"backup").expect("restored ordinary backup");
        assert!(cleanup_after_direct_failure(
            &manifest,
            &backup,
            &dirty,
            &fixture.build,
            &fixture.root,
        ));
        assert!(!backup.exists());
        assert!(!manifest.exists());
        assert!(!dirty.exists());
    }

    #[test]
    fn explicit_invalidation_revokes_backup_before_manifest_authority() {
        let fixture = Fixture::new("ordered-explicit-invalidation");
        let manifest = fixture.root.join("native-relink.json");
        let backup = fixture.root.join("native-source.ino");
        fs::write(&manifest, b"manifest").expect("manifest");
        fs::create_dir(&backup).expect("unsafe backup entry");

        let error = invalidate_native_relink_baseline(&manifest, &backup)
            .expect_err("unsafe backup must stop explicit invalidation");
        assert_eq!(error.code, NativeRelinkGateCode::UnsafeFilesystemEntry);
        assert!(
            manifest.exists(),
            "independent manifest authority must be revoked last"
        );
        assert!(backup.is_dir());
    }

    #[test]
    fn transaction_depfile_rewrites_only_target_and_generated_source() {
        let fixture = Fixture::new("depfile-rewrite");
        let transaction = fixture.build.join("txn");
        fs::create_dir_all(transaction.join("sketch")).expect("transaction sketch directory");
        let transaction_object = transaction.join("sketch/sketch.o");
        let transaction_source = transaction.join("sketch/demo.ino.cpp");
        let depfile = transaction.join("sketch.d");
        let canonical_object = fixture.build.join("sketch/demo.ino.cpp.o");
        let canonical_source = fixture.build.join("sketch/demo.ino.cpp");
        let header = fixture.write_source("cores/arduino/Arduino.h", b"header");
        for (path, bytes) in [
            (&transaction_object, b"new-object".as_slice()),
            (&transaction_source, b"new-source".as_slice()),
            (&canonical_object, b"old-object".as_slice()),
            (&canonical_source, b"old-source".as_slice()),
        ] {
            fs::write(path, bytes).expect("depfile fixture file");
        }
        let header_fragment = format!(" \\\r\n {} \\\r\n", header.display());
        let raw = format!(
            "{}: \\\r\n {}{} {}\r\n",
            transaction_object.display(),
            transaction_source.display(),
            header_fragment,
            header.display(),
        );
        fs::write(&depfile, &raw).expect("transaction depfile");
        rewrite_transaction_depfile(
            &depfile,
            &fixture.root,
            &transaction_object,
            &canonical_object,
            &transaction_source,
            &canonical_source,
            &[fixture.root.clone()],
        )
        .expect("rewrite depfile");
        let rewritten = fs::read_to_string(&depfile).expect("rewritten depfile");
        assert!(!rewritten.contains(&transaction.to_string_lossy().to_string()));
        assert!(rewritten.contains(&canonical_object.to_string_lossy().to_string()));
        assert!(rewritten.contains(&canonical_source.to_string_lossy().to_string()));
        assert!(
            rewritten.contains(&header_fragment),
            "unrelated dependency bytes changed"
        );
    }

    #[tokio::test]
    async fn non_compile_intents_touch_no_state_or_callbacks() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let fixture = Fixture::new("intent-gate");
        let sentinel = fixture.root.join("sentinel.txt");
        fs::write(&sentinel, b"unchanged").expect("sentinel");
        let empty_paths: Vec<PathBuf> = Vec::new();
        let empty_lines: Vec<String> = Vec::new();
        let callbacks = AtomicUsize::new(0);
        for intent in [
            super::super::CompileIntent::UploadReady,
            super::super::CompileIntent::Background,
            super::super::CompileIntent::LockedReplay,
        ] {
            let baseline = NativeRelinkBaselineInput {
                canonical_fqbn: "arduino:avr:uno",
                build_signature: "unused",
                cli_version: "unused",
                toolchain_key: "unused",
                toolchain_identity_generation: 1,
                access_mode: TEST_ACCESS_MODE,
                authorization_key: TEST_AUTHORIZATION_KEY,
                project_name: "demo.ino",
                project_dir: &fixture.root,
                build_dir: &fixture.build,
                sketch_ino: &sentinel,
                build_options: &sentinel,
                ccdb: &sentinel,
                core_archive: &fixture.build.join("core/core.a"),
                property_contract_sha256: "unused",
                combine_recipe: "unused",
                objcopy_eep_recipe: "unused",
                objcopy_hex_recipe: "unused",
                size_recipe: "unused",
                allowed_working_roots: &empty_paths,
                allowed_source_roots: &empty_paths,
                allowed_library_roots: &empty_paths,
                allowed_tool_roots: &empty_paths,
                dependency_content_signature: "unused",
                library_tree_signature: None,
                include_analysis: NativeRelinkIncludeManifest {
                    headers: vec!["arduino.h".into()],
                    preprocessor_fingerprint: "unused".into(),
                    synthesis_safe: true,
                },
                source: SIMPLE,
                normalized_source: SIMPLE,
                backup_relative_path: "source.ino",
                artifact_paths: &empty_paths,
                eep_path: &sentinel,
                size_summary: &empty_lines,
            };
            let manifest = fixture.root.join("manifest.json");
            let backup = fixture.root.join("source.ino");
            let outcome = try_native_relink_compile_only(
                NativeRelinkRunInput {
                    baseline,
                    manifest_path: &manifest,
                    backup_path: &backup,
                    managed_build_root: &fixture.root,
                    compile_intent: intent,
                    force_rebuild: false,
                    attempt: 0,
                    cache_reset_pending: false,
                },
                &NativeRelinkRunControl::new(),
                || {
                    callbacks.fetch_add(1, Ordering::SeqCst);
                    Ok("unexpected".into())
                },
                |_| {
                    callbacks.fetch_add(1, Ordering::SeqCst);
                    Ok(vec!["unexpected".into()])
                },
                || {
                    callbacks.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await;
            assert!(matches!(outcome, NativeRelinkOutcome::NotEligible { .. }));
            assert_eq!(fs::read(&sentinel).expect("sentinel remains"), b"unchanged");
            assert!(!manifest.exists());
            assert!(!backup.exists());
        }
        assert_eq!(callbacks.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn structured_dirty_marker_without_manifest_blocks_without_cleanup_or_fallback_callbacks()
    {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let fixture = Fixture::new("untrusted-dirty-blocked");
        let sentinel = fixture.build.join("must-remain.txt");
        fs::write(&sentinel, b"unchanged").expect("sentinel");
        let manifest = fixture.root.join("manifest.json");
        let dirty = native_relink_dirty_marker_path(&manifest).expect("dirty path");
        let marker = NativeRelinkDirtyMarker {
            schema_version: NATIVE_RELINK_MANIFEST_SCHEMA_VERSION,
            engine_contract: NATIVE_RELINK_ENGINE_CONTRACT.into(),
            run_id: "1234-5678-9".into(),
            previous_manifest_sha256: "a".repeat(64),
            stage: "commit-outputs".into(),
            started_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_millis(),
        };
        write_dirty_marker(&dirty, &marker).expect("structurally valid forged marker");
        let source = fixture.root.join("demo.ino");
        fs::write(&source, SIMPLE).expect("source fixture");
        let empty_paths: Vec<PathBuf> = Vec::new();
        let empty_lines: Vec<String> = Vec::new();
        let callbacks = AtomicUsize::new(0);
        let outcome = try_native_relink_compile_only(
            NativeRelinkRunInput {
                baseline: NativeRelinkBaselineInput {
                    canonical_fqbn: "arduino:avr:uno",
                    build_signature: "unused",
                    cli_version: "unused",
                    toolchain_key: "unused",
                    toolchain_identity_generation: 1,
                    access_mode: TEST_ACCESS_MODE,
                    authorization_key: TEST_AUTHORIZATION_KEY,
                    project_name: "demo.ino",
                    project_dir: &fixture.root,
                    build_dir: &fixture.build,
                    sketch_ino: &source,
                    build_options: &source,
                    ccdb: &source,
                    core_archive: &fixture.build.join("core/core.a"),
                    property_contract_sha256: "unused",
                    combine_recipe: "unused",
                    objcopy_eep_recipe: "unused",
                    objcopy_hex_recipe: "unused",
                    size_recipe: "unused",
                    allowed_working_roots: &empty_paths,
                    allowed_source_roots: &empty_paths,
                    allowed_library_roots: &empty_paths,
                    allowed_tool_roots: &empty_paths,
                    dependency_content_signature: "unused",
                    library_tree_signature: None,
                    include_analysis: NativeRelinkIncludeManifest {
                        headers: vec!["arduino.h".into()],
                        preprocessor_fingerprint: "unused".into(),
                        synthesis_safe: true,
                    },
                    source: SIMPLE,
                    normalized_source: SIMPLE,
                    backup_relative_path: "source.ino",
                    artifact_paths: &empty_paths,
                    eep_path: &source,
                    size_summary: &empty_lines,
                },
                manifest_path: &manifest,
                backup_path: &fixture.root.join("source.ino"),
                managed_build_root: &fixture.root,
                compile_intent: super::super::CompileIntent::CompileOnly,
                force_rebuild: false,
                attempt: 0,
                cache_reset_pending: false,
            },
            &NativeRelinkRunControl::new(),
            || {
                callbacks.fetch_add(1, Ordering::SeqCst);
                Ok("unexpected".into())
            },
            |_| {
                callbacks.fetch_add(1, Ordering::SeqCst);
                Ok(vec!["unexpected".into()])
            },
            || {
                callbacks.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;

        assert!(
            matches!(
                outcome,
                NativeRelinkOutcome::BlockedByUntrustedMarker {
                    code: NativeRelinkGateCode::MissingFile,
                    ..
                }
            ),
            "{outcome:?}"
        );
        assert_eq!(callbacks.load(Ordering::SeqCst), 0);
        assert_eq!(fs::read(&sentinel).expect("sentinel remains"), b"unchanged");
        assert!(fixture.build.exists(), "managed build must not be deleted");
        assert!(dirty.is_file(), "untrusted marker must not be touched");
        assert!(!manifest.exists(), "a missing manifest must stay missing");
    }

    #[tokio::test]
    async fn authenticated_dirty_cleanup_failure_returns_false_and_preserves_all_state() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let fixture = Fixture::new("authenticated-dirty-cleanup-failure");
        let manifest_path = fixture.root.join("manifest.json");
        let backup_path = fixture.root.join("backup.ino");
        let dirty_path = native_relink_dirty_marker_path(&manifest_path).expect("dirty path");
        let manifest = complete_core_only_manifest(&fixture);
        let manifest_bytes = serde_json::to_vec(&manifest).expect("manifest JSON");
        fs::write(&manifest_path, &manifest_bytes).expect("committed manifest");
        fs::write(&backup_path, SIMPLE).expect("committed source backup");
        write_dirty_marker(
            &dirty_path,
            &NativeRelinkDirtyMarker {
                schema_version: NATIVE_RELINK_MANIFEST_SCHEMA_VERSION,
                engine_contract: NATIVE_RELINK_ENGINE_CONTRACT.into(),
                run_id: "1234-5678-9".into(),
                previous_manifest_sha256: sha256_bytes(&manifest_bytes),
                stage: "commit-outputs".into(),
                started_unix_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock")
                    .as_millis(),
            },
        )
        .expect("authenticated dirty marker");
        let wrong_managed_root = fixture.root.join("wrong-managed-root");
        fs::create_dir(&wrong_managed_root).expect("wrong managed root");
        let source = fixture.root.join("demo.ino");
        fs::write(&source, SIMPLE).expect("source fixture");
        let empty_paths: Vec<PathBuf> = Vec::new();
        let empty_lines: Vec<String> = Vec::new();
        let callbacks = AtomicUsize::new(0);

        let outcome = try_native_relink_compile_only(
            NativeRelinkRunInput {
                baseline: NativeRelinkBaselineInput {
                    canonical_fqbn: "arduino:avr:uno",
                    build_signature: "unused",
                    cli_version: "unused",
                    toolchain_key: "unused",
                    toolchain_identity_generation: 1,
                    access_mode: TEST_ACCESS_MODE,
                    authorization_key: TEST_AUTHORIZATION_KEY,
                    project_name: "demo.ino",
                    project_dir: &fixture.root,
                    build_dir: &fixture.build,
                    sketch_ino: &source,
                    build_options: &source,
                    ccdb: &source,
                    core_archive: &fixture.build.join("core/core.a"),
                    property_contract_sha256: "unused",
                    combine_recipe: "unused",
                    objcopy_eep_recipe: "unused",
                    objcopy_hex_recipe: "unused",
                    size_recipe: "unused",
                    allowed_working_roots: &empty_paths,
                    allowed_source_roots: &empty_paths,
                    allowed_library_roots: &empty_paths,
                    allowed_tool_roots: &empty_paths,
                    dependency_content_signature: "unused",
                    library_tree_signature: None,
                    include_analysis: NativeRelinkIncludeManifest {
                        headers: vec!["arduino.h".into()],
                        preprocessor_fingerprint: "unused".into(),
                        synthesis_safe: true,
                    },
                    source: SIMPLE,
                    normalized_source: SIMPLE,
                    backup_relative_path: "backup.ino",
                    artifact_paths: &empty_paths,
                    eep_path: &source,
                    size_summary: &empty_lines,
                },
                manifest_path: &manifest_path,
                backup_path: &backup_path,
                managed_build_root: &wrong_managed_root,
                compile_intent: super::super::CompileIntent::CompileOnly,
                force_rebuild: false,
                attempt: 0,
                cache_reset_pending: false,
            },
            &NativeRelinkRunControl::new(),
            || {
                callbacks.fetch_add(1, Ordering::SeqCst);
                Ok("unexpected".into())
            },
            |_| {
                callbacks.fetch_add(1, Ordering::SeqCst);
                Ok(vec!["unexpected".into()])
            },
            || {
                callbacks.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;

        assert!(
            matches!(
                outcome,
                NativeRelinkOutcome::DirtyFailure {
                    build_was_cleaned: false,
                    ..
                }
            ),
            "{outcome:?}"
        );
        assert_eq!(callbacks.load(Ordering::SeqCst), 0);
        assert!(fixture.build.exists());
        assert!(backup_path.exists());
        assert!(manifest_path.exists());
        assert!(dirty_path.exists());
    }

    #[tokio::test]
    async fn cancelled_run_control_stops_before_state_or_callbacks() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let fixture = Fixture::new("cancelled-before-start");
        let sentinel = fixture.root.join("sentinel.txt");
        fs::write(&sentinel, b"unchanged").expect("sentinel");
        let empty_paths: Vec<PathBuf> = Vec::new();
        let empty_lines: Vec<String> = Vec::new();
        let callbacks = AtomicUsize::new(0);
        let control = NativeRelinkRunControl::new();
        control.cancel();
        let outcome = try_native_relink_compile_only(
            NativeRelinkRunInput {
                baseline: NativeRelinkBaselineInput {
                    canonical_fqbn: "arduino:avr:uno",
                    build_signature: "unused",
                    cli_version: "unused",
                    toolchain_key: "unused",
                    toolchain_identity_generation: 1,
                    access_mode: TEST_ACCESS_MODE,
                    authorization_key: TEST_AUTHORIZATION_KEY,
                    project_name: "demo.ino",
                    project_dir: &fixture.root,
                    build_dir: &fixture.build,
                    sketch_ino: &sentinel,
                    build_options: &sentinel,
                    ccdb: &sentinel,
                    core_archive: &fixture.build.join("core/core.a"),
                    property_contract_sha256: "unused",
                    combine_recipe: "unused",
                    objcopy_eep_recipe: "unused",
                    objcopy_hex_recipe: "unused",
                    size_recipe: "unused",
                    allowed_working_roots: &empty_paths,
                    allowed_source_roots: &empty_paths,
                    allowed_library_roots: &empty_paths,
                    allowed_tool_roots: &empty_paths,
                    dependency_content_signature: "unused",
                    library_tree_signature: None,
                    include_analysis: NativeRelinkIncludeManifest {
                        headers: vec!["arduino.h".into()],
                        preprocessor_fingerprint: "unused".into(),
                        synthesis_safe: true,
                    },
                    source: SIMPLE,
                    normalized_source: SIMPLE,
                    backup_relative_path: "source.ino",
                    artifact_paths: &empty_paths,
                    eep_path: &sentinel,
                    size_summary: &empty_lines,
                },
                manifest_path: &fixture.root.join("manifest.json"),
                backup_path: &fixture.root.join("source.ino"),
                managed_build_root: &fixture.root,
                compile_intent: super::super::CompileIntent::CompileOnly,
                force_rebuild: false,
                attempt: 0,
                cache_reset_pending: false,
            },
            &control,
            || {
                callbacks.fetch_add(1, Ordering::SeqCst);
                Ok("unexpected".into())
            },
            |_| {
                callbacks.fetch_add(1, Ordering::SeqCst);
                Ok(vec!["unexpected".into()])
            },
            || {
                callbacks.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(
            matches!(
                outcome,
                NativeRelinkOutcome::Cancelled {
                    build_was_cleaned: false,
                    ..
                }
            ),
            "{outcome:?}"
        );
        assert_eq!(callbacks.load(Ordering::SeqCst), 0);
        assert_eq!(fs::read(&sentinel).expect("sentinel remains"), b"unchanged");
        assert!(!fixture.root.join("manifest.json").exists());
        assert!(!fixture.root.join("source.ino").exists());
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn fake_avr_tools_commit_a_complete_transaction_without_txn_dep_paths() {
        let fixture = Fixture::new("engine-e2e");
        let project = fixture.root.join("project");
        fs::create_dir_all(&project).expect("project");
        let sketch_ino = project.join("demo.ino");
        fs::write(&sketch_ino, SIMPLE).expect("initial source");
        let generated_source = fixture.build.join("sketch/demo.ino.cpp");
        fs::write(
            &generated_source,
            render_direct_cpp(
                SIMPLE,
                &sketch_ino,
                &NativeRelinkIncludeManifest {
                    headers: vec!["arduino.h".into()],
                    preprocessor_fingerprint: "fixture".into(),
                    synthesis_safe: true,
                },
                false,
            )
            .expect("initial translation"),
        )
        .expect("generated source");
        let sketch_object = fixture.build.join("sketch/demo.ino.cpp.o");
        let sketch_depfile = fixture.build.join("sketch/demo.ino.cpp.d");
        fs::write(&sketch_object, b"old-object").expect("old object");
        fs::write(
            &sketch_depfile,
            format!(
                "{}: {}\r\n",
                sketch_object.display(),
                generated_source.display()
            ),
        )
        .expect("old depfile");
        let core_source = fixture.write_source("cores/arduino/main.cpp", b"void core_main(){}\n");
        let core_object = fixture.build.join("core/main.cpp.o");
        fs::write(&core_object, b"core-object").expect("core object");
        let build_options = fixture.build.join("build.options.json");
        fs::write(&build_options, b"{\"fqbn\":\"arduino:avr:uno\"}").expect("build options");
        let elf = fixture.build.join("demo.ino.elf");
        let hex = fixture.build.join("demo.ino.hex");
        let eep = fixture.build.join("demo.ino.eep");
        for (path, bytes) in [
            (&elf, b"old-elf".as_slice()),
            (&hex, b"old-hex".as_slice()),
            (&eep, b"old-eep".as_slice()),
        ] {
            fs::write(path, bytes).expect("old artifact");
        }

        let compile_script = fixture.root.join("fake-compile.cmd");
        let link_script = fixture.root.join("fake-link.cmd");
        let copy_script = fixture.root.join("fake-copy.cmd");
        let size_script = fixture.root.join("fake-size.cmd");
        fs::write(
            &compile_script,
            b"@echo off\r\nsetlocal\r\nset \"src=%~4\"\r\nset \"out=%~6\"\r\nif not defined out exit /b 2\r\nif not defined src exit /b 3\r\n>\"%out%\" echo fake-object\r\nfor %%F in (\"%out%\") do set \"dep=%%~dpnF.d\"\r\n>\"%dep%\" echo %out%: %src%\r\n",
        )
        .expect("compile tool");
        fs::write(
            &link_script,
            b"@echo off\r\nsetlocal\r\nset \"out=%~7\"\r\nif not defined out exit /b 2\r\n>\"%out%\" echo fake-elf\r\n",
        )
        .expect("link tool");
        fs::write(
            &copy_script,
            b"@echo off\r\ncopy /y \"%~1\" \"%~2\" >nul\r\n",
        )
        .expect("objcopy tool");
        fs::write(
            &size_script,
            b"@echo off\r\necho text data bss dec hex filename\r\necho 100 0 0 100 64 %~1\r\n",
        )
        .expect("size tool");
        let command_processor = PathBuf::from(std::env::var("COMSPEC").expect("COMSPEC"));
        let tool_root = command_processor
            .parent()
            .expect("command processor parent")
            .to_path_buf();
        let command_processor_string = command_processor.to_string_lossy().into_owned();
        let sketch_command = NativeCompileCommand {
            directory: fixture.root.to_string_lossy().into_owned(),
            arguments: vec![
                command_processor_string.clone(),
                "/D".into(),
                "/C".into(),
                compile_script.to_string_lossy().into_owned(),
                "-Os".into(),
                "-flto".into(),
                "-c".into(),
                generated_source.to_string_lossy().into_owned(),
                "-o".into(),
                sketch_object.to_string_lossy().into_owned(),
            ],
            command: String::new(),
            file: generated_source.to_string_lossy().into_owned(),
            output: None,
        };
        let core_command = NativeCompileCommand {
            directory: fixture.root.to_string_lossy().into_owned(),
            arguments: vec![
                command_processor_string.clone(),
                "/D".into(),
                "/C".into(),
                compile_script.to_string_lossy().into_owned(),
                "-Os".into(),
                "-flto".into(),
                "-c".into(),
                core_source.to_string_lossy().into_owned(),
                "-o".into(),
                core_object.to_string_lossy().into_owned(),
            ],
            command: String::new(),
            file: core_source.to_string_lossy().into_owned(),
            output: None,
        };
        let ccdb = fixture.build.join("compile_commands.json");
        fs::write(
            &ccdb,
            serde_json::to_vec(&vec![sketch_command, core_command]).expect("CCDB JSON"),
        )
        .expect("CCDB");
        let quote = |path: &Path| format!("\"{}\"", path.display());
        let core_archive = fixture.build.join("core/core.a");
        let combine_recipe = format!(
            "{} /D /C {} -Os -flto -fuse-linker-plugin {} {} -o {}",
            quote(&command_processor),
            quote(&link_script),
            quote(&sketch_object),
            quote(&core_archive),
            quote(&elf),
        );
        let eep_recipe = format!(
            "{} /D /C {} {} {}",
            quote(&command_processor),
            quote(&copy_script),
            quote(&elf),
            quote(&eep),
        );
        let hex_recipe = format!(
            "{} /D /C {} {} {}",
            quote(&command_processor),
            quote(&copy_script),
            quote(&elf),
            quote(&hex),
        );
        let size_recipe = format!(
            "{} /D /C {} {}",
            quote(&command_processor),
            quote(&size_script),
            quote(&elf),
        );
        let allowed_source_roots = vec![fixture.root.clone()];
        let allowed_tool_roots = vec![tool_root];
        let artifact_paths = vec![elf.clone(), hex.clone()];
        let old_size = vec!["Sketch uses 100 bytes".to_string()];
        let property_hash = "a".repeat(64);
        let initial_input = NativeRelinkBaselineInput {
            canonical_fqbn: "arduino:avr:uno",
            build_signature: "release-signature",
            cli_version: "1.3.0",
            toolchain_key: "avr-gcc-7.3.0",
            toolchain_identity_generation: 1,
            access_mode: TEST_ACCESS_MODE,
            authorization_key: TEST_AUTHORIZATION_KEY,
            project_name: "demo.ino",
            project_dir: &project,
            build_dir: &fixture.build,
            sketch_ino: &sketch_ino,
            build_options: &build_options,
            ccdb: &ccdb,
            core_archive: &core_archive,
            property_contract_sha256: &property_hash,
            combine_recipe: &combine_recipe,
            objcopy_eep_recipe: &eep_recipe,
            objcopy_hex_recipe: &hex_recipe,
            size_recipe: &size_recipe,
            allowed_working_roots: &allowed_source_roots,
            allowed_source_roots: &allowed_source_roots,
            allowed_library_roots: &[],
            allowed_tool_roots: &allowed_tool_roots,
            dependency_content_signature: "dependency-signature",
            library_tree_signature: None,
            include_analysis: NativeRelinkIncludeManifest {
                headers: vec!["arduino.h".into()],
                preprocessor_fingerprint: "arduino-only".into(),
                synthesis_safe: true,
            },
            source: SIMPLE,
            normalized_source: SIMPLE,
            backup_relative_path: "native-source.ino",
            artifact_paths: &artifact_paths,
            eep_path: &eep,
            size_summary: &old_size,
        };
        let captured =
            capture_native_relink_baseline(initial_input.clone()).expect("initial baseline");
        let manifest = fixture.root.join("native-relink.json");
        let backup = fixture.root.join("native-source.ino");
        let original_build_options = fs::read(&build_options).expect("build options bytes");
        fs::write(&build_options, b"{\"fqbn\":\"tampered\"}").expect("tamper build options");
        assert_eq!(
            commit_native_relink_baseline(&captured, &manifest, &backup, SIMPLE)
                .unwrap_err()
                .code,
            NativeRelinkGateCode::DirtyBuild
        );
        assert!(!manifest.exists() && !backup.exists());
        fs::write(&build_options, &original_build_options).expect("restore build options");

        let original_ccdb = fs::read(&ccdb).expect("CCDB bytes");
        let mut tampered_ccdb = original_ccdb.clone();
        tampered_ccdb.push(b' ');
        fs::write(&ccdb, tampered_ccdb).expect("tamper CCDB");
        assert_eq!(
            commit_native_relink_baseline(&captured, &manifest, &backup, SIMPLE)
                .unwrap_err()
                .code,
            NativeRelinkGateCode::DirtyBuild
        );
        assert!(!manifest.exists() && !backup.exists());
        fs::write(&ccdb, original_ccdb).expect("restore CCDB");

        // The transaction callers deliberately rely on this helper as their
        // first complete seal after the final identity lease.  Exercise every
        // core-only binding class with a same-size mutation so removing a
        // caller-side duplicate scan can never weaken the authoritative gate.
        for (label, path) in [
            ("Core archive", &core_archive),
            ("sketch object", &sketch_object),
            ("sketch depfile", &sketch_depfile),
            ("ELF artifact", &elf),
            ("HEX artifact", &hex),
            ("EEP artifact", &eep),
        ] {
            let original = fs::read(path).unwrap_or_else(|error| {
                panic!("cannot read {label} before final-seal tamper: {error}")
            });
            let mut changed = original.clone();
            changed[0] ^= 1;
            fs::write(path, &changed)
                .unwrap_or_else(|error| panic!("cannot tamper {label} before final seal: {error}"));
            let error = commit_native_relink_baseline(&captured, &manifest, &backup, SIMPLE)
                .expect_err("same-size final-seal tamper must fail closed");
            assert_eq!(error.code, NativeRelinkGateCode::DirtyBuild, "{label}");
            assert!(!manifest.exists() && !backup.exists(), "{label}");
            fs::write(path, original).unwrap_or_else(|error| {
                panic!("cannot restore {label} after final-seal tamper: {error}")
            });
        }

        commit_native_relink_baseline(&captured, &manifest, &backup, SIMPLE)
            .expect("commit initial baseline");
        fs::write(&sketch_ino, MEDIUM).expect("edited source");
        let current_input = NativeRelinkBaselineInput {
            // Simulate a desktop restart or a completed managed-package cache
            // invalidation. The request-local generation changed, but the
            // independently resolved strong toolchain key is identical.
            toolchain_identity_generation: 2,
            source: MEDIUM,
            normalized_source: MEDIUM,
            ..initial_input
        };
        let dependency_refresh_calls = std::sync::atomic::AtomicUsize::new(0);
        let outcome = try_native_relink_compile_only(
            NativeRelinkRunInput {
                baseline: current_input,
                manifest_path: &manifest,
                backup_path: &backup,
                managed_build_root: &fixture.root,
                compile_intent: super::super::CompileIntent::CompileOnly,
                force_rebuild: false,
                attempt: 0,
                cache_reset_pending: false,
            },
            &NativeRelinkRunControl::new(),
            || {
                dependency_refresh_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok("dependency-signature".into())
            },
            |_| Ok(vec!["Sketch uses 100 bytes".into()]),
            || Ok(()),
        )
        .await;
        assert!(
            matches!(outcome, NativeRelinkOutcome::Succeeded { .. }),
            "{outcome:?}"
        );
        assert_eq!(
            dependency_refresh_calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "request-proof reuse must never suppress the independent post-compile dependency refresh"
        );
        let depfile_after = fs::read_to_string(&sketch_depfile).expect("committed depfile");
        assert!(!depfile_after.contains(".ck-native-relink-"));
        #[cfg(windows)]
        assert!(
            !depfile_after.contains(r"\\?\"),
            "committed GCC depfiles must use a round-trippable DOS path spelling"
        );
        let (_, dependencies) = parse_single_rule_depfile(&depfile_after).expect("final depfile");
        assert!(dependencies.iter().any(|token| {
            path_key(&resolve_token_path(&token.decoded, &fixture.root))
                == path_key(&generated_source)
        }));
        assert!(manifest.exists());
        assert!(
            !native_relink_dirty_marker_path(&manifest)
                .expect("dirty path")
                .exists()
        );
        assert!(
            fs::read_dir(&fixture.build)
                .expect("inspect committed build root")
                .flatten()
                .all(|entry| {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    !(name.starts_with(".ck-native-relink-") && name.ends_with(".txn"))
                }),
            "a successful commit must remove its transaction directory before clearing dirty state"
        );

        // A concurrent Core mutation after output commit must not be blessed
        // by the freshly captured manifest. The whole managed build and the
        // previous commit marker are invalidated so the caller can run one
        // clean native CLI fallback.
        fs::write(&sketch_ino, COMPLEX).expect("second edited source");
        let next_input = NativeRelinkBaselineInput {
            canonical_fqbn: "arduino:avr:uno",
            build_signature: "release-signature",
            cli_version: "1.3.0",
            toolchain_key: "avr-gcc-7.3.0",
            toolchain_identity_generation: 2,
            access_mode: TEST_ACCESS_MODE,
            authorization_key: TEST_AUTHORIZATION_KEY,
            project_name: "demo.ino",
            project_dir: &project,
            build_dir: &fixture.build,
            sketch_ino: &sketch_ino,
            build_options: &build_options,
            ccdb: &ccdb,
            core_archive: &core_archive,
            property_contract_sha256: &property_hash,
            combine_recipe: &combine_recipe,
            objcopy_eep_recipe: &eep_recipe,
            objcopy_hex_recipe: &hex_recipe,
            size_recipe: &size_recipe,
            allowed_working_roots: &allowed_source_roots,
            allowed_source_roots: &allowed_source_roots,
            allowed_library_roots: &[],
            allowed_tool_roots: &allowed_tool_roots,
            dependency_content_signature: "dependency-signature",
            library_tree_signature: None,
            include_analysis: NativeRelinkIncludeManifest {
                headers: vec!["arduino.h".into()],
                preprocessor_fingerprint: "arduino-only".into(),
                synthesis_safe: true,
            },
            source: COMPLEX,
            normalized_source: COMPLEX,
            backup_relative_path: "native-source.ino",
            artifact_paths: &artifact_paths,
            eep_path: &eep,
            size_summary: &old_size,
        };
        let tampered = try_native_relink_compile_only(
            NativeRelinkRunInput {
                baseline: next_input,
                manifest_path: &manifest,
                backup_path: &backup,
                managed_build_root: &fixture.root,
                compile_intent: super::super::CompileIntent::CompileOnly,
                force_rebuild: false,
                attempt: 0,
                cache_reset_pending: false,
            },
            &NativeRelinkRunControl::new(),
            || Ok("dependency-signature".into()),
            |_| Ok(vec!["Sketch uses 100 bytes".into()]),
            || {
                fs::write(&core_archive, b"externally-tampered-core")
                    .map_err(|error| error.to_string())
            },
        )
        .await;
        assert!(
            matches!(tampered, NativeRelinkOutcome::DirtyFailure { .. }),
            "{tampered:?}"
        );
        assert!(!manifest.exists());
        assert!(!fixture.build.exists());
    }

    #[test]
    fn release_ccdb_accepts_unique_sketch_and_core_entries() {
        let fixture = Fixture::new("ccdb-ok");
        let entries = fixture.ccdb();
        let contract = validate_release_ccdb_contract(
            &entries,
            &fixture.build,
            &[fixture.root.clone()],
            &[fixture.root.clone()],
            &[],
            &[fixture.tools.clone()],
        )
        .expect("valid Release CCDB");
        assert_eq!(contract.entries.len(), 2);
        assert_eq!(contract.core_entry_count, 1);
        assert_eq!(contract.sketch_entry_index, 0);
        assert!(contract.sketch_source.ends_with("demo.ino.cpp"));
        assert!(contract.sketch_object.ends_with("demo.ino.cpp.o"));
    }

    #[test]
    fn release_ccdb_deduplicates_only_identical_rows() {
        let fixture = Fixture::new("ccdb-dedup");
        let mut entries = fixture.ccdb();
        entries.push(entries[1].clone());
        let contract = validate_release_ccdb_contract(
            &entries,
            &fixture.build,
            &[fixture.root.clone()],
            &[fixture.root.clone()],
            &[],
            &[fixture.tools.clone()],
        )
        .expect("exact duplicate");
        assert_eq!(contract.entries.len(), 2);

        let mut conflict = entries;
        conflict[2].arguments.push("-DCHANGED".into());
        assert_eq!(
            validate_release_ccdb_contract(
                &conflict,
                &fixture.build,
                &[fixture.root.clone()],
                &[fixture.root.clone()],
                &[],
                &[fixture.tools.clone()],
            )
            .unwrap_err()
            .code,
            NativeRelinkGateCode::CcdbAmbiguous
        );
    }

    #[test]
    fn release_ccdb_rejects_library_objects_and_wrong_flags() {
        let fixture = Fixture::new("ccdb-flags");
        let mut library_entries = fixture.ccdb();
        let library = fixture.write_source("libraries/Lib/src/lib.cpp", b"void lib(){}\n");
        fs::create_dir_all(fixture.build.join("libraries/Lib")).expect("library output parent");
        library_entries.push(fixture.command(
            &library,
            &fixture.build.join("libraries/Lib/lib.cpp.o"),
            true,
        ));
        assert_eq!(
            validate_release_ccdb_contract(
                &library_entries,
                &fixture.build,
                &[fixture.root.clone()],
                &[fixture.root.clone()],
                &[],
                &[fixture.tools.clone()],
            )
            .unwrap_err()
            .code,
            NativeRelinkGateCode::NonCoreObject
        );

        let mut wrong_lto = fixture.ccdb();
        let position = wrong_lto[0]
            .arguments
            .iter()
            .position(|token| token == "-flto")
            .expect("lto flag");
        wrong_lto[0].arguments[position] = "-fno-lto".into();
        assert_eq!(
            validate_release_ccdb_contract(
                &wrong_lto,
                &fixture.build,
                &[fixture.root.clone()],
                &[fixture.root.clone()],
                &[],
                &[fixture.tools.clone()],
            )
            .unwrap_err()
            .code,
            NativeRelinkGateCode::LtoMismatch
        );
    }

    #[test]
    fn release_ccdb_rejects_command_form_response_and_output_escape() {
        let fixture = Fixture::new("ccdb-unsafe");
        let mut command_form = fixture.ccdb();
        command_form[0].command = command_form[0].arguments.join(" ");
        command_form[0].arguments.clear();
        assert_eq!(
            validate_release_ccdb_contract(
                &command_form,
                &fixture.build,
                &[fixture.root.clone()],
                &[fixture.root.clone()],
                &[],
                &[fixture.tools.clone()],
            )
            .unwrap_err()
            .code,
            NativeRelinkGateCode::CcdbUnsupportedEntry
        );

        let mut response = fixture.ccdb();
        response[0].arguments.insert(1, "@flags.rsp".into());
        assert_eq!(
            validate_release_ccdb_contract(
                &response,
                &fixture.build,
                &[fixture.root.clone()],
                &[fixture.root.clone()],
                &[],
                &[fixture.tools.clone()],
            )
            .unwrap_err()
            .code,
            NativeRelinkGateCode::CcdbResponseFileUnsupported
        );

        let mut escape = fixture.ccdb();
        let output = escape[0]
            .arguments
            .iter()
            .position(|token| token == "-o")
            .expect("output");
        escape[0].arguments[output + 1] = fixture.root.join("escape.o").to_string_lossy().into();
        assert_eq!(
            validate_release_ccdb_contract(
                &escape,
                &fixture.build,
                &[fixture.root.clone()],
                &[fixture.root.clone()],
                &[],
                &[fixture.tools.clone()],
            )
            .unwrap_err()
            .code,
            NativeRelinkGateCode::CcdbOutputOutsideBuild
        );
    }

    #[test]
    fn release_ccdb_rejects_missing_or_nonregular_object() {
        let fixture = Fixture::new("ccdb-object");
        let entries = fixture.ccdb();
        let output = command_output_token(&entries[0].arguments, Path::new(&entries[0].directory))
            .expect("output");
        fs::remove_file(&output).expect("remove object");
        assert_eq!(
            validate_release_ccdb_contract(
                &entries,
                &fixture.build,
                &[fixture.root.clone()],
                &[fixture.root.clone()],
                &[],
                &[fixture.tools.clone()],
            )
            .unwrap_err()
            .code,
            NativeRelinkGateCode::MissingFile
        );
    }

    #[cfg(windows)]
    #[test]
    fn release_ccdb_resolves_only_same_absolute_tool_with_exe_suffix() {
        let fixture = Fixture::new("ccdb-exe");
        let entries = fixture.ccdb();
        for name in ["avr-g++", "avr-gcc"] {
            let source = fixture.tools.join(name);
            let destination = fixture.tools.join(format!("{name}.exe"));
            fs::rename(source, destination).expect("rename fake tool to exe");
        }
        validate_release_ccdb_contract(
            &entries,
            &fixture.build,
            &[fixture.root.clone()],
            &[fixture.root.clone()],
            &[],
            &[fixture.tools.clone()],
        )
        .expect("same absolute executable with Windows suffix");
    }

    #[test]
    fn recipe_contract_preserves_native_avr_lto_and_artifact_paths() {
        let fixture = Fixture::new("recipe-ok");
        let elf = fixture.build.join("demo.ino.elf");
        let eep = fixture.build.join("demo.ino.eep");
        let hex = fixture.build.join("demo.ino.hex");
        let sketch_object = fixture.build.join("sketch/demo.ino.cpp.o");
        fs::write(&sketch_object, b"sketch-object").expect("sketch object");
        let combine = format!(
            "\"{}\" -Os -flto -fuse-linker-plugin -o \"{}\" \"{}\" \"{}\"",
            fixture.tools.join("avr-gcc").display(),
            elf.display(),
            sketch_object.display(),
            fixture.build.join("core/core.a").display()
        );
        let objcopy_eep = format!(
            "\"{}\" -O ihex \"{}\" \"{}\"",
            fixture.tools.join("avr-objcopy").display(),
            elf.display(),
            eep.display()
        );
        let objcopy_hex = format!(
            "\"{}\" -O ihex \"{}\" \"{}\"",
            fixture.tools.join("avr-objcopy").display(),
            elf.display(),
            hex.display()
        );
        let size = format!(
            "\"{}\" -A \"{}\"",
            fixture.tools.join("avr-size").display(),
            elf.display()
        );
        let sketch_tokens = vec!["avr-g++".into(), "-Os".into(), "-flto".into()];
        let contract = validate_release_recipe_contract(NativeReleaseRecipeInput {
            property_contract_sha256: "contract",
            combine: &combine,
            objcopy_eep: &objcopy_eep,
            objcopy_hex: &objcopy_hex,
            size: &size,
            build_dir: &fixture.build,
            project_elf: &elf,
            project_eep: &eep,
            project_hex: &hex,
            core_archive: &fixture.build.join("core/core.a"),
            sketch_object: &sketch_object,
            library_objects: &[],
            allowed_tool_roots: &[fixture.tools.clone()],
            sketch_compile_tokens: &sketch_tokens,
        })
        .expect("valid recipe contract");
        assert_eq!(contract.manifest.archive_file, "core/core.a");
        assert_eq!(contract.combine_tokens[1], "-Os");
    }

    #[test]
    fn recipe_contract_rejects_shell_placeholder_lto_and_path_mismatch() {
        let fixture = Fixture::new("recipe-bad");
        let elf = fixture.build.join("demo.ino.elf");
        let eep = fixture.build.join("demo.ino.eep");
        let hex = fixture.build.join("demo.ino.hex");
        let sketch_object = fixture.build.join("sketch/demo.ino.cpp.o");
        fs::write(&sketch_object, b"sketch-object").expect("sketch object");
        let good_eep = format!(
            "\"{}\" \"{}\" \"{}\"",
            fixture.tools.join("avr-objcopy").display(),
            elf.display(),
            eep.display()
        );
        let good_hex = format!(
            "\"{}\" \"{}\" \"{}\"",
            fixture.tools.join("avr-objcopy").display(),
            elf.display(),
            hex.display()
        );
        let good_size = format!(
            "\"{}\" -A \"{}\"",
            fixture.tools.join("avr-size").display(),
            elf.display()
        );
        let sketch_tokens = vec!["avr-g++".into(), "-Os".into(), "-flto".into()];
        for combine in [
            format!(
                "\"{}\" -Os -flto -fuse-linker-plugin -o \"{}\" {{archive_file}}",
                fixture.tools.join("avr-gcc").display(),
                elf.display()
            ),
            format!(
                "\"{}\" -Os -flto -fuse-linker-plugin -o \"{}\" \"{}\" && echo bad",
                fixture.tools.join("avr-gcc").display(),
                elf.display(),
                fixture.build.join("core/core.a").display()
            ),
            format!(
                "\"{}\" -Os -fno-lto -fuse-linker-plugin -o \"{}\" \"{}\"",
                fixture.tools.join("avr-gcc").display(),
                elf.display(),
                fixture.build.join("core/core.a").display()
            ),
        ] {
            assert!(
                validate_release_recipe_contract(NativeReleaseRecipeInput {
                    property_contract_sha256: "contract",
                    combine: &combine,
                    objcopy_eep: &good_eep,
                    objcopy_hex: &good_hex,
                    size: &good_size,
                    build_dir: &fixture.build,
                    project_elf: &elf,
                    project_eep: &eep,
                    project_hex: &hex,
                    core_archive: &fixture.build.join("core/core.a"),
                    sketch_object: &sketch_object,
                    library_objects: &[],
                    allowed_tool_roots: &[fixture.tools.clone()],
                    sketch_compile_tokens: &sketch_tokens,
                })
                .is_err()
            );
        }
    }

    fn marker_payload(value: &serde_json::Value) -> String {
        hex::encode(serde_json::to_vec(value).expect("marker JSON"))
    }

    fn ck_begin_marker(block_type: &str, section: &str) -> String {
        let payload = marker_payload(&serde_json::json!({
            "boundaryId": "definition:block-1",
            "blockId": "block-1",
            "blockType": block_type,
            "section": section,
            "confidence": "exact"
        }));
        format!("/* @ck-source-begin:v1:{payload} */")
    }

    fn ck_end_marker() -> String {
        format!(
            "/* @ck-source-end:v1:{} */",
            hex::encode("definition:block-1")
        )
    }

    fn ck_legacy_marker() -> String {
        format!("/* @ck:v1:{} */", hex::encode("block-1"))
    }

    fn audited_mstimer2_source() -> String {
        let mut lines = CK_MSTIMER2_AVR_SCAFFOLD
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();
        lines[0].push(' ');
        lines[0].push_str(&ck_begin_marker("control_mstimer2_every", "definition"));
        let last = lines.len() - 1;
        lines[last].push(' ');
        lines[last].push_str(&ck_end_marker());
        format!(
            "{}\n\nvoid ckTimerCallback() {{}}\nvoid setup() {{}}\nvoid loop() {{}}\n",
            lines.join("\n")
        )
    }

    fn generic_library_source(header: &str) -> String {
        format!(
            "#include <{header}> {} {} {}\n\nvoid setup() {{}}\nvoid loop() {{}}\n",
            ck_begin_marker("library_include", "include"),
            ck_legacy_marker(),
            ck_end_marker()
        )
    }

    fn normalized_test_path(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    fn write_library_depfile(object: &Path, dependencies: &[&Path]) -> PathBuf {
        let depfile = object.with_extension("d");
        let raw = format!(
            "{}: {}\n",
            normalized_test_path(object),
            dependencies
                .iter()
                .map(|path| normalized_test_path(path))
                .collect::<Vec<_>>()
                .join(" ")
        );
        fs::write(&depfile, raw).expect("library depfile");
        depfile
    }

    fn manifest_with_library_bindings(
        roots: Vec<NativeRelinkLibraryRootManifest>,
        objects: Vec<NativeRelinkLibraryObjectManifest>,
    ) -> NativeRelinkManifest {
        let identity = NativeRelinkFileIdentity {
            relative_path: "unused.bin".into(),
            size: 1,
            sha256: "a".repeat(64),
        };
        NativeRelinkManifest {
            schema_version: NATIVE_RELINK_MANIFEST_SCHEMA_VERSION,
            engine_contract: NATIVE_RELINK_ENGINE_CONTRACT.into(),
            capability_class: NATIVE_RELINK_LIBRARY_CAPABILITY_CLASS.into(),
            canonical_fqbn: "arduino:avr:nano:cpu=atmega328old".into(),
            profile: "release".into(),
            build_signature: "unused".into(),
            cli_version: "unused".into(),
            toolchain_key: "unused".into(),
            toolchain_identity_generation: 1,
            access_mode: TEST_ACCESS_MODE.into(),
            authorization_key: TEST_AUTHORIZATION_KEY.into(),
            project_name: "demo.ino".into(),
            canonical_project_dir: std::env::temp_dir().to_string_lossy().into_owned(),
            canonical_build_dir: std::env::temp_dir().to_string_lossy().into_owned(),
            build_options_sha256: "b".repeat(64),
            recipe: NativeRelinkRecipeManifest {
                property_contract_sha256: "c".repeat(64),
                combine_sha256: "d".repeat(64),
                objcopy_eep_sha256: "e".repeat(64),
                objcopy_hex_sha256: "f".repeat(64),
                size_sha256: "0".repeat(64),
                archive_file: "core/core.a".into(),
            },
            ccdb: NativeRelinkCcdbManifest {
                schema: "release-ccdb-v2".into(),
                size: 1,
                sha256: "1".repeat(64),
                entry_count: objects.len() + 2,
                command_graph_sha256: "2".repeat(64),
                sketch_source_relative_path: "sketch/demo.ino.cpp".into(),
                sketch_object_relative_path: "sketch/demo.ino.cpp.o".into(),
                sketch_command_sha256: "3".repeat(64),
                sketch_depfile_sha256: "4".repeat(64),
                non_core_non_sketch_entry_count: objects.len(),
            },
            core_archive: identity.clone(),
            core_cache_identity: identity.clone(),
            dependency_content_signature: "unused".into(),
            library_tree_signature: None,
            library_roots: roots,
            library_objects: objects,
            include_analysis: NativeRelinkIncludeManifest {
                headers: vec!["wire.h".into()],
                preprocessor_fingerprint: "unused".into(),
                synthesis_safe: true,
            },
            translation_contract: DIRECT_CPP_LIBRARY_TRANSLATION_CONTRACT.into(),
            last_source: NativeRelinkSourceManifest {
                raw_sha256: "5".repeat(64),
                normalized_sha256: "6".repeat(64),
                backup_relative_path: "backup.ino".into(),
            },
            sketch_object: identity.clone(),
            sketch_depfile_sha256: "7".repeat(64),
            outputs: NativeRelinkOutputManifest {
                artifacts: vec![identity.clone()],
                eep: identity,
                size_summary: vec!["unused".into()],
            },
        }
    }

    fn complete_core_only_manifest(fixture: &Fixture) -> NativeRelinkManifest {
        let build_options = fixture.build.join("build.options.json");
        let ccdb = fixture.build.join("compile_commands.json");
        let sketch_object = fixture.build.join("sketch/demo.ino.cpp.o");
        let sketch_depfile = fixture.build.join("sketch/demo.ino.cpp.d");
        let elf = fixture.build.join("demo.ino.elf");
        let hex = fixture.build.join("demo.ino.hex");
        let eep = fixture.build.join("demo.ino.eep");
        for (path, bytes) in [
            (&build_options, b"build-options".as_slice()),
            (&ccdb, b"ccdb".as_slice()),
            (&sketch_object, b"sketch-object".as_slice()),
            (&sketch_depfile, b"sketch-depfile".as_slice()),
            (&elf, b"elf".as_slice()),
            (&hex, b"hex".as_slice()),
            (&eep, b"eep".as_slice()),
        ] {
            fs::write(path, bytes).expect("complete manifest fixture file");
        }

        let mut manifest = manifest_with_library_bindings(Vec::new(), Vec::new());
        manifest.capability_class = NATIVE_RELINK_CAPABILITY_CLASS.into();
        manifest.translation_contract = DIRECT_CPP_TRANSLATION_CONTRACT.into();
        manifest.include_analysis.headers = vec!["arduino.h".into()];
        manifest.include_analysis.synthesis_safe = true;
        manifest.canonical_project_dir = std::fs::canonicalize(&fixture.root)
            .expect("canonical project root")
            .to_string_lossy()
            .into_owned();
        manifest.canonical_build_dir = std::fs::canonicalize(&fixture.build)
            .expect("canonical build root")
            .to_string_lossy()
            .into_owned();
        manifest.build_options_sha256 = sha256_file(&build_options).expect("build options hash");
        let ccdb_metadata = fs::metadata(&ccdb).expect("CCDB metadata");
        manifest.ccdb.size = ccdb_metadata.len();
        manifest.ccdb.sha256 = sha256_file(&ccdb).expect("CCDB hash");
        manifest.ccdb.entry_count = 2;
        manifest.ccdb.non_core_non_sketch_entry_count = 0;
        manifest.ccdb.sketch_source_relative_path = "sketch/demo.ino.cpp".into();
        manifest.ccdb.sketch_object_relative_path = "sketch/demo.ino.cpp.o".into();
        let depfile_sha256 = sha256_file(&sketch_depfile).expect("sketch depfile hash");
        manifest.ccdb.sketch_depfile_sha256 = depfile_sha256.clone();
        manifest.sketch_depfile_sha256 = depfile_sha256;
        manifest.core_archive =
            file_identity_within(&fixture.build.join("core/core.a"), &fixture.build)
                .expect("Core archive identity");
        manifest.core_cache_identity = file_identity_within(
            &fixture.build.join(CORE_CACHE_IDENTITY_RELATIVE_PATH),
            &fixture.build,
        )
        .expect("Core cache identity");
        manifest.sketch_object =
            file_identity_within(&sketch_object, &fixture.build).expect("sketch object identity");
        manifest.outputs.artifacts = vec![
            file_identity_within(&elf, &fixture.build).expect("ELF identity"),
            file_identity_within(&hex, &fixture.build).expect("HEX identity"),
        ];
        manifest.outputs.eep = file_identity_within(&eep, &fixture.build).expect("EEP identity");
        manifest
    }

    #[test]
    fn pre_dirty_manifest_gate_preserves_regular_upload_state_until_commit_seal() {
        let fixture = Fixture::new("pre-dirty-read-only");
        let manifest = complete_core_only_manifest(&fixture);
        manifest.validate_header().expect("valid complete manifest");
        let stale = [
            fixture.build.join(".ck-upload-artifacts.json"),
            fixture.build.join("demo.ino.with_bootloader.hex"),
            fixture.build.join("demo.ino.with_bootloader.bin"),
        ];
        for path in &stale {
            fs::write(path, b"upload-only").expect("stale upload artifact");
        }

        validate_manifest_build_state_read_only(&manifest)
            .expect("regular upload state may coexist with the prior baseline");
        for path in &stale {
            assert_eq!(
                fs::read(path).expect("stale artifact remains"),
                b"upload-only",
                "pre-dirty validation must perform zero filesystem mutation"
            );
        }

        seal_manifest_build_state_before_commit(&manifest)
            .expect("new-state commit seal may remove upload-only leftovers");
        assert!(
            stale.iter().all(|path| !path.exists()),
            "commit-time cleanup semantics must remain intact"
        );
        let build = canonical_directory(&fixture.build).expect("canonical build");
        for artifact in &manifest.outputs.artifacts {
            validate_file_binding(&build, artifact, "Firmware artifact")
                .expect("compile-only cleanup must preserve firmware outputs");
        }
        validate_file_binding(&build, &manifest.outputs.eep, "EEP artifact")
            .expect("compile-only cleanup must preserve EEPROM output");
    }

    #[test]
    fn pre_dirty_manifest_gate_rejects_non_regular_upload_state_without_mutation() {
        let fixture = Fixture::new("pre-dirty-upload-directory");
        let manifest = complete_core_only_manifest(&fixture);
        let unsafe_path = fixture.build.join(".ck-upload-artifacts.json");
        fs::create_dir(&unsafe_path).expect("malicious upload manifest directory");

        let error = validate_manifest_build_state_read_only(&manifest)
            .expect_err("non-regular upload state must fail closed");
        assert_eq!(error.code, NativeRelinkGateCode::UnsafeFilesystemEntry);
        assert!(
            unsafe_path.is_dir(),
            "pre-dirty validation must not remove an untrusted entry"
        );
    }

    #[cfg(unix)]
    #[test]
    fn pre_dirty_manifest_gate_rejects_symlinked_upload_state_without_mutation() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new("pre-dirty-upload-symlink");
        let manifest = complete_core_only_manifest(&fixture);
        let target = fixture.root.join("outside-upload-manifest.json");
        let unsafe_path = fixture.build.join(".ck-upload-artifacts.json");
        fs::write(&target, b"outside").expect("outside upload manifest");
        symlink(&target, &unsafe_path).expect("upload manifest symlink");

        let error = validate_manifest_build_state_read_only(&manifest)
            .expect_err("symlinked upload state must fail closed");
        assert_eq!(error.code, NativeRelinkGateCode::UnsafeFilesystemEntry);
        assert!(
            fs::symlink_metadata(&unsafe_path)
                .expect("symlink remains")
                .file_type()
                .is_symlink(),
            "pre-dirty validation must not remove an untrusted symlink"
        );
    }

    #[cfg(windows)]
    #[test]
    fn pre_dirty_manifest_gate_rejects_reparse_upload_state_without_mutation() {
        use std::os::windows::fs::MetadataExt;

        let fixture = Fixture::new("pre-dirty-upload-junction");
        let target = fixture.root.join("outside-upload-manifest");
        let unsafe_path = fixture.build.join(".ck-upload-artifacts.json");
        fs::create_dir(&target).expect("outside upload manifest directory");
        junction::create(&target, &unsafe_path).expect("upload manifest junction");
        let manifest = complete_core_only_manifest(&fixture);

        let error = validate_manifest_build_state_read_only(&manifest)
            .expect_err("reparse upload state must fail closed");
        assert_eq!(error.code, NativeRelinkGateCode::UnsafeFilesystemEntry);
        assert!(
            fs::symlink_metadata(&unsafe_path)
                .expect("junction remains")
                .file_attributes()
                & FILE_ATTRIBUTE_REPARSE_POINT
                != 0,
            "pre-dirty validation must not remove an untrusted reparse point"
        );
        junction::delete(&unsafe_path).expect("delete upload manifest junction");
    }

    fn graph_identity_ccdb(command_graph_sha256: &str) -> NativeReleaseCcdbContract {
        NativeReleaseCcdbContract {
            entries: Vec::new(),
            command_graph_sha256: command_graph_sha256.into(),
            core_command_graph_sha256: "8".repeat(64),
            sketch_entry_index: 0,
            sketch_source: PathBuf::from("sketch/demo.ino.cpp"),
            sketch_object: PathBuf::from("sketch/demo.ino.cpp.o"),
            sketch_command_sha256: "3".repeat(64),
            core_entry_count: 1,
            core_objects: Vec::new(),
            library_objects: Vec::new(),
        }
    }

    fn certified_graph_identity_fixture() -> (NativeRelinkManifest, NativeReleaseCcdbContract) {
        let mut manifest = manifest_with_library_bindings(Vec::new(), Vec::new());
        manifest.access_mode = "certified".into();
        manifest.build_signature = "a".repeat(64);
        manifest.cli_version = "arduino-cli 1.4.1".into();
        manifest.toolchain_key = "arduino|avr|1.8.6|toolchain".into();
        let ccdb = graph_identity_ccdb(&manifest.ccdb.command_graph_sha256);
        (manifest, ccdb)
    }

    #[test]
    fn graph_transition_allows_request_signature_change_only_with_validated_graph_change() {
        let (previous, previous_ccdb) = certified_graph_identity_fixture();
        let mut next = previous.clone();
        next.build_signature = "b".repeat(64);
        next.ccdb.command_graph_sha256 = "9".repeat(64);
        next.include_analysis.headers = vec!["mstimer2.h".into()];
        next.include_analysis.preprocessor_fingerprint = "audited-mstimer2".into();
        next.toolchain_identity_generation =
            previous.toolchain_identity_generation.saturating_add(1);
        let next_ccdb = graph_identity_ccdb(&next.ccdb.command_graph_sha256);

        validate_graph_transition_identity(&previous, &next, &previous_ccdb, &next_ccdb)
            .expect("an external-library graph edit may update its request build signature");

        let mut signature_only = previous.clone();
        signature_only.build_signature = "b".repeat(64);
        let error = validate_graph_transition_identity(
            &previous,
            &signature_only,
            &previous_ccdb,
            &previous_ccdb,
        )
        .expect_err("signature drift without a complete graph change must fail closed");
        assert_eq!(error.code, NativeRelinkGateCode::InvalidManifest);
        assert!(
            error
                .detail
                .contains("without a validated dependency graph change")
        );

        let mut malformed = next.clone();
        malformed.build_signature = "request-signature".into();
        let error =
            validate_graph_transition_identity(&previous, &malformed, &previous_ccdb, &next_ccdb)
                .expect_err("a graph edit must not authorize a non-hash request identity");
        assert_eq!(error.code, NativeRelinkGateCode::InvalidManifest);
        assert!(error.detail.contains("not a lowercase SHA-256"));
    }

    #[test]
    fn graph_transition_signature_exception_preserves_immutable_target_identity() {
        let (previous, previous_ccdb) = certified_graph_identity_fixture();
        let mut next = previous.clone();
        next.build_signature = "b".repeat(64);
        next.ccdb.command_graph_sha256 = "9".repeat(64);
        next.include_analysis.headers = vec!["mstimer2.h".into()];
        let next_ccdb = graph_identity_ccdb(&next.ccdb.command_graph_sha256);

        let assert_immutable_rejected =
            |candidate: &NativeRelinkManifest, candidate_ccdb: &NativeReleaseCcdbContract| {
                let error = validate_graph_transition_identity(
                    &previous,
                    candidate,
                    &previous_ccdb,
                    candidate_ccdb,
                )
                .expect_err("immutable identity drift must fail closed");
                assert_eq!(error.code, NativeRelinkGateCode::InvalidManifest);
                assert!(
                    error
                        .detail
                        .contains("immutable certified AVR Release/Core identity")
                );
            };

        let mut changed = next.clone();
        changed.canonical_fqbn = "arduino:avr:nano".into();
        assert_immutable_rejected(&changed, &next_ccdb);

        let mut changed = next.clone();
        changed.toolchain_key = "different-toolchain".into();
        assert_immutable_rejected(&changed, &next_ccdb);

        let mut changed = next.clone();
        changed.authorization_key = "c".repeat(64);
        assert_immutable_rejected(&changed, &next_ccdb);

        let mut changed = next.clone();
        changed.recipe.property_contract_sha256 = "d".repeat(64);
        assert_immutable_rejected(&changed, &next_ccdb);

        let mut changed = next.clone();
        changed.core_archive.sha256 = "e".repeat(64);
        assert_immutable_rejected(&changed, &next_ccdb);

        let mut changed_ccdb = next_ccdb.clone();
        changed_ccdb.core_command_graph_sha256 = "f".repeat(64);
        assert_immutable_rejected(&next, &changed_ccdb);
    }

    #[test]
    fn mstimer2_scaffold_is_exact_and_render_injects_arduino_header() {
        let fixture = Fixture::new("mstimer2-translation");
        let source = audited_mstimer2_source();
        let analysis = NativeRelinkIncludeManifest {
            headers: vec!["mstimer2.h".into()],
            preprocessor_fingerprint: "conditional-mstimer2".into(),
            synthesis_safe: false,
        };
        let plan = validate_native_relink_translation(&source, &analysis, true)
            .expect("exact audited MsTimer2 scaffold");
        assert_eq!(plan.contract, CK_MSTIMER2_AVR_TRANSLATION_CONTRACT);
        assert!(plan.inject_arduino_header);
        validate_audited_ck_mstimer2_graph_source(&source, &analysis)
            .expect("the exact CK scaffold is the only admitted conditional graph");
        validate_graph_transition_include_source(&source, &analysis)
            .expect("the graph-transition runner admits the exact CK scaffold");

        let sketch = fixture.root.join("project/demo.ino");
        let rendered = render_direct_cpp(&source, &sketch, &analysis, true)
            .expect("render strict MsTimer2 source");
        assert!(rendered.starts_with("#include <Arduino.h>\n#line 1 \""));
        assert!(rendered.contains("#if defined(ARDUINO_ARCH_AVR)"));
        assert!(rendered.contains("#include <MsTimer2.h>"));
        assert_eq!(rendered.matches("#include <Arduino.h>").count(), 1);

        let spacing_drift = source.replacen("  inline void start()", " inline void start()", 1);
        assert_eq!(
            validate_native_relink_translation(&spacing_drift, &analysis, true)
                .unwrap_err()
                .code,
            NativeRelinkGateCode::TranslationUnsupported
        );

        let wrong_marker = source.replacen(
            &ck_begin_marker("control_mstimer2_every", "definition"),
            &ck_begin_marker("control_timer_every", "definition"),
            1,
        );
        assert_eq!(
            validate_native_relink_translation(&wrong_marker, &analysis, true)
                .unwrap_err()
                .code,
            NativeRelinkGateCode::TranslationUnsupported
        );

        let extra_directive = format!("{source}\n#define USER_SELECTED_TIMER_HEADER <Other.h>\n");
        assert_eq!(
            validate_graph_transition_include_source(&extra_directive, &analysis)
                .unwrap_err()
                .code,
            NativeRelinkGateCode::TranslationUnsupported,
            "an exact scaffold must not authorize a second conditional/macro graph"
        );

        let arbitrary_conditional = "#if defined(ARDUINO_ARCH_AVR)\n#include <MsTimer2.h>\n#endif\nvoid setup() {}\nvoid loop() {}\n";
        assert_eq!(
            validate_graph_transition_include_source(arbitrary_conditional, &analysis)
                .unwrap_err()
                .code,
            NativeRelinkGateCode::TranslationUnsupported,
            "an arbitrary conditional MsTimer2 include must remain fail-closed"
        );

        let macro_include = "#define CK_TIMER_HEADER <MsTimer2.h>\n#include CK_TIMER_HEADER\nvoid setup() {}\nvoid loop() {}\n";
        assert_eq!(
            validate_graph_transition_include_source(macro_include, &analysis)
                .unwrap_err()
                .code,
            NativeRelinkGateCode::TranslationUnsupported,
            "the graph-transition runner must not admit a macro include"
        );

        let literal = NativeRelinkIncludeManifest {
            headers: vec!["wire.h".into()],
            preprocessor_fingerprint: "literal-wire".into(),
            synthesis_safe: true,
        };
        validate_graph_transition_include_source(
            "#include <Wire.h>\nvoid setup() {}\nvoid loop() {}\n",
            &literal,
        )
        .expect("ordinary literal graphs remain admitted");
    }

    #[test]
    fn generic_library_markers_are_strict_and_header_only_translation_is_supported() {
        for header in ["Wire.h", "EEPROM.h"] {
            let source = generic_library_source(header);
            let analysis = NativeRelinkIncludeManifest {
                headers: vec![header.to_ascii_lowercase()],
                preprocessor_fingerprint: format!("literal-{header}"),
                synthesis_safe: true,
            };
            let plan = validate_native_relink_translation(&source, &analysis, true)
                .expect("exact CK markers around a literal library include");
            assert_eq!(plan.contract, DIRECT_CPP_LIBRARY_TRANSLATION_CONTRACT);
            assert!(plan.inject_arduino_header);
        }

        let source = generic_library_source("Wire.h");
        let malformed = source.replacen("/* @ck:v1:", "/* @ck:v2:", 1);
        let analysis = NativeRelinkIncludeManifest {
            headers: vec!["wire.h".into()],
            preprocessor_fingerprint: "literal-wire".into(),
            synthesis_safe: true,
        };
        assert_eq!(
            validate_native_relink_translation(&malformed, &analysis, true)
                .unwrap_err()
                .code,
            NativeRelinkGateCode::TranslationUnsupported
        );
    }

    #[test]
    fn release_ccdb_preserves_wire_like_multi_object_order_and_rejects_unknown_root() {
        let fixture = Fixture::new("wire-multi-object");
        let wire_root = fixture.platform.join("libraries/Wire");
        let spi_root = fixture.platform.join("libraries/SPI");
        let wire_cpp = fixture.write_source("libraries/Wire/src/Wire.cpp", b"void wire_cpp(){}\n");
        let twi_c = fixture.write_source("libraries/Wire/src/utility/twi.c", b"void twi_c(){}\n");
        let spi_cpp = fixture.write_source("libraries/SPI/src/SPI.cpp", b"void spi_cpp(){}\n");
        let wire_object = fixture.build.join("libraries/Wire/src/Wire.cpp.o");
        let twi_object = fixture.build.join("libraries/Wire/src/utility/twi.c.o");
        let spi_object = fixture.build.join("libraries/SPI/src/SPI.cpp.o");
        let mut entries = fixture.ccdb();
        entries.push(fixture.command(&wire_cpp, &wire_object, true));
        entries.push(fixture.command(&twi_c, &twi_object, false));
        entries.push(fixture.command(&spi_cpp, &spi_object, true));

        let contract = validate_release_ccdb_contract(
            &entries,
            &fixture.build,
            &[fixture.root.clone()],
            &[fixture.root.clone()],
            &[wire_root.clone(), spi_root],
            &[fixture.tools.clone()],
        )
        .expect("bounded ordered Wire/SPI C/C++ objects");
        assert_eq!(contract.library_objects.len(), 3);
        assert_eq!(
            contract.library_objects[0].source,
            fs::canonicalize(&wire_cpp).unwrap()
        );
        assert_eq!(
            contract.library_objects[1].source,
            fs::canonicalize(&twi_c).unwrap()
        );
        assert_eq!(
            contract.library_objects[2].source,
            fs::canonicalize(&spi_cpp).unwrap()
        );
        assert_eq!(contract.library_objects[0].library_root_index, 0);
        assert_eq!(contract.library_objects[1].library_root_index, 0);
        assert_eq!(contract.library_objects[2].library_root_index, 1);

        let overlap_error = canonical_library_roots(&[wire_root.clone(), wire_root.join("src")])
            .expect_err(
                "ancestor/descendant library roots must not make root_index order-dependent",
            );
        assert_eq!(overlap_error.code, NativeRelinkGateCode::InvalidManifest);
        assert!(overlap_error.detail.contains("overlap"));

        assert_eq!(
            validate_release_ccdb_contract(
                &entries,
                &fixture.build,
                &[fixture.root.clone()],
                &[fixture.root.clone()],
                &[],
                &[fixture.tools.clone()],
            )
            .unwrap_err()
            .code,
            NativeRelinkGateCode::NonCoreObject
        );
    }

    #[test]
    fn eeprom_header_only_root_has_a_tree_identity_without_a_library_object() {
        let fixture = Fixture::new("eeprom-header-only");
        let eeprom_root = fixture.platform.join("libraries/EEPROM");
        fixture.write_source("libraries/EEPROM/src/EEPROM.h", b"class EEPROMClass {};\n");
        let roots = canonical_library_roots(std::slice::from_ref(&eeprom_root))
            .expect("bounded header-only root");
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].1.object_count, 0);
        assert!(is_sha256_hex(&roots[0].1.tree_sha256));

        let contract = validate_release_ccdb_contract(
            &fixture.ccdb(),
            &fixture.build,
            &[fixture.root.clone()],
            &[fixture.root.clone()],
            std::slice::from_ref(&eeprom_root),
            &[fixture.tools.clone()],
        )
        .expect("header-only roots add no CCDB object");
        assert!(contract.library_objects.is_empty());
    }

    #[test]
    fn declared_header_only_dependency_requires_exact_tu_depfile_evidence() {
        let fixture = Fixture::new("declared-header-only-evidence");
        let a_root = fixture.platform.join("libraries/ParentA");
        let b_root = fixture.platform.join("libraries/LeafB");
        let a_source = fixture.write_source(
            "libraries/ParentA/src/ParentA.cpp",
            b"#include <ParentA.h>\n#include <LeafB.inc>\n",
        );
        let a_header = fixture.write_source("libraries/ParentA/src/ParentA.h", b"#pragma once\n");
        let b_fragment = fixture.write_source(
            "libraries/LeafB/src/LeafB.inc",
            b"static const int leaf_b = 1;\n",
        );
        fs::write(
            a_root.join("library.properties"),
            b"name=Parent A\nversion=1.0.0\ndepends=Leaf B\n",
        )
        .expect("Parent A metadata");
        fs::write(
            b_root.join("library.properties"),
            b"name=Leaf B\nversion=1.0.0\n",
        )
        .expect("Leaf B metadata");
        let object = fixture.build.join("libraries/ParentA/src/ParentA.cpp.o");
        fs::create_dir_all(object.parent().expect("object parent")).expect("object directory");
        fs::write(&object, b"object").expect("object");
        let depfile = write_library_depfile(&object, &[&a_source, &a_header, &b_fragment]);
        let evidence = vec![NativeRelinkLibraryDepfileUseInput {
            source: a_source.clone(),
            object: object.clone(),
            depfile: depfile.clone(),
            working_directory: fixture.root.clone(),
            source_is_sketch: false,
        }];
        let mut captured = canonical_library_roots(&[a_root.clone(), b_root.clone()])
            .expect("bounded candidate roots");
        captured[0].1.object_count = 1;
        let analysis = NativeRelinkIncludeManifest {
            headers: vec!["parenta.h".into()],
            preprocessor_fingerprint: "parent-a".into(),
            synthesis_safe: true,
        };
        validate_library_header_root_bindings(
            &analysis,
            &captured,
            &evidence,
            std::slice::from_ref(&fixture.root),
        )
        .expect("declared header-only .inc dependency is proven by the exact library TU depfile");

        write_library_depfile(&object, &[&a_source, &a_header]);
        let missing = validate_library_header_root_bindings(
            &analysis,
            &captured,
            &evidence,
            std::slice::from_ref(&fixture.root),
        )
        .expect_err("metadata without compiler dependency evidence must fail closed");
        assert_eq!(missing.code, NativeRelinkGateCode::InvalidManifest);
        assert!(missing.detail.contains("no sealed sketch/library depfile"));

        write_library_depfile(&object, &[&a_source, &a_header, &b_fragment]);
        fs::write(
            a_root.join("library.properties"),
            b"name=Parent A\nversion=1.0.0\n",
        )
        .expect("remove declared dependency");
        let forged = validate_library_header_root_bindings(
            &analysis,
            &captured,
            &evidence,
            std::slice::from_ref(&fixture.root),
        )
        .expect_err("a depfile path without a declared edge must not authorize the leaf");
        assert_eq!(forged.code, NativeRelinkGateCode::InvalidManifest);
        assert!(forged.detail.contains("unused by the sealed"));

        fs::write(
            a_root.join("library.properties"),
            b"name=Parent A\nversion=1.0.0\ndepends=Leaf B\n",
        )
        .expect("restore declared dependency");
        fs::remove_file(&b_fragment).expect("remove referenced fragment");
        let missing_path = validate_library_header_root_bindings(
            &analysis,
            &captured,
            &evidence,
            std::slice::from_ref(&fixture.root),
        )
        .expect_err("a missing depfile dependency must fail closed");
        assert_eq!(missing_path.code, NativeRelinkGateCode::MissingFile);

        fs::write(&b_fragment, b"static const int leaf_b = 1;\n")
            .expect("restore referenced fragment");
        let outside = tempfile::tempdir().expect("outside tempdir");
        let outside_header = outside.path().join("outside.inc");
        fs::write(&outside_header, b"outside\n").expect("outside dependency");
        write_library_depfile(
            &object,
            &[&a_source, &a_header, &b_fragment, &outside_header],
        );
        let escaped = validate_library_header_root_bindings(
            &analysis,
            &captured,
            &evidence,
            &[fixture.platform.clone(), fixture.build.clone()],
        )
        .expect_err("an ordinary dependency outside every managed root must fail closed");
        assert_eq!(escaped.code, NativeRelinkGateCode::ToolOutsideManagedRoot);
    }

    #[test]
    fn sketch_depfile_can_prove_header_only_to_header_only_declared_closure() {
        let fixture = Fixture::new("sketch-header-only-closure");
        let a_root = fixture.platform.join("libraries/DirectA");
        let b_root = fixture.platform.join("libraries/TransitiveB");
        let a_header = fixture.write_source(
            "libraries/DirectA/src/DirectA.h",
            b"#include <TransitiveB.tpp>\n",
        );
        let b_fragment = fixture.write_source(
            "libraries/TransitiveB/src/TransitiveB.tpp",
            b"template<class T> T transitive_b(T value) { return value; }\n",
        );
        fs::write(
            a_root.join("library.properties"),
            b"name=Direct A\nversion=1.0.0\ndepends=Transitive B\n",
        )
        .expect("Direct A metadata");
        fs::write(
            b_root.join("library.properties"),
            b"name=Transitive B\nversion=1.0.0\n",
        )
        .expect("Transitive B metadata");
        let sketch = fixture.sketch_source();
        let object = fixture.build.join("sketch/demo.ino.cpp.o");
        fs::write(&object, b"sketch-object").expect("sketch object");
        let depfile = write_library_depfile(&object, &[&sketch, &a_header, &b_fragment]);
        let evidence = vec![NativeRelinkLibraryDepfileUseInput {
            source: sketch,
            object,
            depfile,
            working_directory: fixture.root.clone(),
            source_is_sketch: true,
        }];
        let captured =
            canonical_library_roots(&[a_root, b_root]).expect("bounded header-only roots");
        let analysis = NativeRelinkIncludeManifest {
            headers: vec!["directa.h".into()],
            preprocessor_fingerprint: "direct-a".into(),
            synthesis_safe: true,
        };
        validate_library_header_root_bindings(
            &analysis,
            &captured,
            &evidence,
            std::slice::from_ref(&fixture.root),
        )
        .expect("the exact sketch depfile proves a header-only transitive .tpp dependency");
    }

    #[test]
    fn library_depfile_unknown_root_and_same_size_binding_tamper_fail_closed() {
        let fixture = Fixture::new("library-binding-tamper");
        let library_root = fixture.platform.join("libraries/Wire");
        let source = fixture.write_source("libraries/Wire/src/Wire.cpp", b"void wire_cpp(){}\n");
        let header = fixture.write_source("libraries/Wire/src/Wire.h", b"void wire_cpp();\n");
        let core_root = fixture.platform.join("cores/arduino");
        let core_header = fixture.write_source("cores/arduino/Arduino.h", b"void setup();\n");
        let outside = fixture.write_source("libraries/Outside/src/Outside.h", b"void outside();\n");
        let object = fixture.build.join("libraries/Wire/src/Wire.cpp.o");
        let mut entries = fixture.ccdb();
        entries.push(fixture.command(&source, &object, true));
        let ccdb = validate_release_ccdb_contract(
            &entries,
            &fixture.build,
            &[fixture.root.clone()],
            &[fixture.root.clone()],
            std::slice::from_ref(&library_root),
            &[fixture.tools.clone()],
        )
        .expect("one bounded library object");
        let object_contract = &ccdb.library_objects[0];

        write_library_depfile(&object, &[&source, &header, &header]);
        capture_library_object_manifest(
            object_contract,
            &fixture.build,
            std::slice::from_ref(&library_root),
        )
        .expect("duplicate canonical library dependencies collapse safely");

        write_library_depfile(&object, &[&source, &core_header, &core_header]);
        capture_library_object_manifest(
            object_contract,
            &fixture.build,
            &[library_root.clone(), core_root],
        )
        .expect("duplicate canonical core dependency collapses across admitted roots");

        write_library_depfile(&object, &[&source, &source, &header]);
        assert_eq!(
            capture_library_object_manifest(
                object_contract,
                &fixture.build,
                std::slice::from_ref(&library_root),
            )
            .unwrap_err()
            .code,
            NativeRelinkGateCode::CcdbAmbiguous
        );

        write_library_depfile(&object, &[&source, &header, &header, &outside]);
        assert_eq!(
            capture_library_object_manifest(
                object_contract,
                &fixture.build,
                std::slice::from_ref(&library_root),
            )
            .unwrap_err()
            .code,
            NativeRelinkGateCode::ToolOutsideManagedRoot
        );

        let depfile = write_library_depfile(&object, &[&source, &header]);
        let library_object = capture_library_object_manifest(
            object_contract,
            &fixture.build,
            std::slice::from_ref(&library_root),
        )
        .expect("exact library depfile binding");
        let mut roots = canonical_library_roots(std::slice::from_ref(&library_root))
            .expect("library root identity")
            .into_iter()
            .map(|(_, manifest)| manifest)
            .collect::<Vec<_>>();
        roots[0].object_count = 1;
        let manifest = manifest_with_library_bindings(roots, vec![library_object]);
        validate_library_manifest_bindings(&manifest, &fixture.build)
            .expect("unchanged library bindings");

        let original_header = fs::read(&header).expect("header bytes");
        let mut changed_header = original_header.clone();
        changed_header[0] ^= 1;
        fs::write(&header, &changed_header).expect("same-size tree tamper");
        assert_eq!(
            validate_library_manifest_bindings(&manifest, &fixture.build)
                .unwrap_err()
                .code,
            NativeRelinkGateCode::DirtyBuild
        );
        fs::write(&header, original_header).expect("restore header");

        let original_object = fs::read(&object).expect("object bytes");
        let mut changed_object = original_object.clone();
        changed_object[0] ^= 1;
        fs::write(&object, &changed_object).expect("same-size object tamper");
        assert_eq!(
            validate_library_manifest_bindings(&manifest, &fixture.build)
                .unwrap_err()
                .code,
            NativeRelinkGateCode::DirtyBuild
        );
        fs::write(&object, original_object).expect("restore object");

        let original_depfile = fs::read(&depfile).expect("depfile bytes");
        let mut changed_depfile = original_depfile.clone();
        changed_depfile[0] ^= 1;
        fs::write(&depfile, changed_depfile).expect("same-size depfile tamper");
        assert_eq!(
            validate_library_manifest_bindings(&manifest, &fixture.build)
                .unwrap_err()
                .code,
            NativeRelinkGateCode::DirtyBuild
        );
    }

    #[test]
    fn combine_recipe_preserves_sketch_then_library_then_core_link_order() {
        let fixture = Fixture::new("library-link-order");
        let elf = fixture.build.join("demo.ino.elf");
        let eep = fixture.build.join("demo.ino.eep");
        let hex = fixture.build.join("demo.ino.hex");
        let sketch = fixture.build.join("sketch/demo.ino.cpp.o");
        let wire = fixture.build.join("libraries/Wire/src/Wire.cpp.o");
        let twi = fixture.build.join("libraries/Wire/src/utility/twi.c.o");
        for path in [&sketch, &wire, &twi] {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("link object parent");
            }
            fs::write(path, b"object").expect("link object");
        }
        let combine = format!(
            "\"{}\" -Os -flto -fuse-linker-plugin -o \"{}\" {{object_files}} \"{{archive_file_path}}\"",
            fixture.tools.join("avr-gcc").display(),
            elf.display()
        );
        let objcopy_eep = format!(
            "\"{}\" -O ihex \"{}\" \"{}\"",
            fixture.tools.join("avr-objcopy").display(),
            elf.display(),
            eep.display()
        );
        let objcopy_hex = format!(
            "\"{}\" -O ihex \"{}\" \"{}\"",
            fixture.tools.join("avr-objcopy").display(),
            elf.display(),
            hex.display()
        );
        let size = format!(
            "\"{}\" -A \"{}\"",
            fixture.tools.join("avr-size").display(),
            elf.display()
        );
        let library_objects = vec![wire.clone(), twi.clone()];
        let sketch_tokens = vec!["avr-g++".into(), "-Os".into(), "-flto".into()];
        let contract = validate_release_recipe_contract(NativeReleaseRecipeInput {
            property_contract_sha256: "contract",
            combine: &combine,
            objcopy_eep: &objcopy_eep,
            objcopy_hex: &objcopy_hex,
            size: &size,
            build_dir: &fixture.build,
            project_elf: &elf,
            project_eep: &eep,
            project_hex: &hex,
            core_archive: &fixture.build.join("core/core.a"),
            sketch_object: &sketch,
            library_objects: &library_objects,
            allowed_tool_roots: &[fixture.tools.clone()],
            sketch_compile_tokens: &sketch_tokens,
        })
        .expect("bounded library link recipe");

        let positions = [&sketch, &wire, &twi, &fixture.build.join("core/core.a")].map(|path| {
            contract
                .combine_tokens
                .iter()
                .position(|token| {
                    !token.starts_with('-')
                        && path_key(&resolve_token_path(token, &fixture.build)) == path_key(path)
                })
                .expect("required link input")
        });
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn graph_transition_commits_only_current_library_graph_before_canonical_link() {
        let fixture = Fixture::new("graph-canonical-library-commit");
        let old_object = fixture.build.join("libraries/Old/src/Old.cpp.o");
        fs::create_dir_all(old_object.parent().expect("old object parent"))
            .expect("old library graph");
        fs::write(&old_object, b"stale-object").expect("stale object");

        let transaction_object = fixture.build.join("txn/out/library-0.o");
        let transaction_depfile = transaction_object.with_extension("d");
        fs::create_dir_all(transaction_object.parent().expect("transaction parent"))
            .expect("transaction output directory");
        fs::write(&transaction_object, b"fresh-object").expect("transaction object");
        fs::write(&transaction_depfile, b"canonical.o: source.cpp\n").expect("transaction depfile");
        let canonical_object = fixture.build.join("libraries/Wire/src/Wire.cpp.o");
        let canonical_depfile = canonical_object.with_extension("d");
        let outputs = vec![(
            transaction_object.clone(),
            transaction_depfile.clone(),
            canonical_object.clone(),
            canonical_depfile.clone(),
        )];

        commit_graph_transition_library_outputs(&fixture.build, &outputs)
            .expect("validated graph commit");
        assert!(
            !old_object.exists(),
            "removed library object survived transition"
        );
        assert_eq!(fs::read(&canonical_object).unwrap(), b"fresh-object");
        assert_eq!(
            fs::read(&canonical_depfile).unwrap(),
            b"canonical.o: source.cpp\n"
        );
        assert!(!transaction_object.exists());
        assert!(!transaction_depfile.exists());

        let sketch = fixture.build.join("sketch/demo.ino.cpp.o");
        let transaction_sketch = fixture.build.join("txn/out/sketch.o");
        let core = fixture.build.join("core/core.a");
        let final_elf = fixture.build.join("demo.ino.elf");
        let transaction_elf = fixture.build.join("txn/out/project.elf");
        let tokens = vec![
            fixture.tools.join("avr-gcc").to_string_lossy().into_owned(),
            "-o".into(),
            final_elf.to_string_lossy().into_owned(),
            sketch.to_string_lossy().into_owned(),
            canonical_object.to_string_lossy().into_owned(),
            core.to_string_lossy().into_owned(),
        ];
        let linked = graph_transition_link_tokens(
            &tokens,
            &fixture.build,
            &sketch,
            &transaction_sketch,
            &transaction_elf,
        )
        .expect("canonical graph link tokens");
        let inputs = linked
            .iter()
            .filter(|token| !token.starts_with('-'))
            .map(|token| path_key(&resolve_token_path(token, &fixture.build)))
            .collect::<Vec<_>>();
        let transaction_sketch_position = inputs
            .iter()
            .position(|path| *path == path_key(&transaction_sketch))
            .expect("transaction sketch input");
        let library_position = inputs
            .iter()
            .position(|path| *path == path_key(&canonical_object))
            .expect("canonical library input");
        let core_position = inputs
            .iter()
            .position(|path| *path == path_key(&core))
            .expect("canonical core input");
        assert!(transaction_sketch_position < library_position);
        assert!(library_position < core_position);
        assert!(
            linked.iter().all(|token| !token.contains("library-0.o")),
            "transaction-local library path leaked into AVR LTO link"
        );
    }

    #[test]
    fn graph_transition_failure_after_library_commit_cleans_entire_managed_build() {
        let fixture = Fixture::new("graph-post-commit-cleanup");
        let transaction_object = fixture.build.join("txn/out/library-0.o");
        let transaction_depfile = transaction_object.with_extension("d");
        fs::create_dir_all(transaction_object.parent().expect("transaction parent"))
            .expect("transaction output directory");
        fs::write(&transaction_object, b"fresh-object").expect("transaction object");
        fs::write(&transaction_depfile, b"canonical.o: source.cpp\n").expect("transaction depfile");
        let canonical_object = fixture.build.join("libraries/Wire/src/Wire.cpp.o");
        let canonical_depfile = canonical_object.with_extension("d");
        commit_graph_transition_library_outputs(
            &fixture.build,
            &[(
                transaction_object,
                transaction_depfile,
                canonical_object,
                canonical_depfile,
            )],
        )
        .expect("canonical graph was committed before injected link failure");

        let manifest = fixture.root.join("native-relink.json");
        let backup = fixture.root.join("native-source.ino");
        let dirty = fixture.root.join("native-relink.json.dirty");
        for path in [&manifest, &backup, &dirty] {
            fs::write(path, b"state").expect("transaction state");
        }
        assert!(cleanup_after_direct_failure(
            &manifest,
            &backup,
            &dirty,
            &fixture.build,
            &fixture.root,
        ));
        assert!(!fixture.build.exists());
        assert!(!manifest.exists());
        assert!(!backup.exists());
        assert!(!dirty.exists());
    }

    fn transition_contract_with_sources(
        root: &Path,
        sources: impl IntoIterator<Item = PathBuf>,
    ) -> NativeReleaseCcdbContract {
        let library_objects = sources
            .into_iter()
            .enumerate()
            .map(|(index, source)| NativeReleaseLibraryObjectContract {
                library_root_index: 0,
                library_root: root.to_path_buf(),
                working_directory: root.to_path_buf(),
                source,
                object: root.join(format!("objects/{index}.o")),
                depfile: root.join(format!("objects/{index}.d")),
                command_sha256: "a".repeat(64),
            })
            .collect();
        NativeReleaseCcdbContract {
            entries: Vec::new(),
            command_graph_sha256: "b".repeat(64),
            core_command_graph_sha256: "c".repeat(64),
            sketch_entry_index: 0,
            sketch_source: root.join("sketch.cpp"),
            sketch_object: root.join("sketch.o"),
            sketch_command_sha256: "d".repeat(64),
            core_entry_count: 1,
            core_objects: Vec::new(),
            library_objects,
        }
    }

    #[test]
    fn graph_transition_detects_deep_tu_added_after_source_snapshot() {
        let fixture = Fixture::new("graph-source-set");
        let library = fixture.root.join("DeepLibrary");
        let first = library.join("src/driver/core.c");
        fs::create_dir_all(first.parent().expect("source parent")).expect("deep source tree");
        fs::write(&first, b"int first(void) { return 1; }\n").expect("first source");
        fs::write(library.join("library.properties"), b"name=DeepLibrary\n")
            .expect("safe properties");
        let canonical_library = fs::canonicalize(&library).expect("canonical library");
        let proof = capture_graph_transition_library_trees(std::slice::from_ref(&library))
            .expect("initial tree proof");
        let contract = transition_contract_with_sources(
            &canonical_library,
            [fs::canonicalize(&first).expect("canonical first source")],
        );
        validate_graph_transition_library_source_set(
            std::slice::from_ref(&canonical_library),
            &contract,
        )
        .expect("initial exact source set");

        let added = library.join("src/driver/nested/added.cpp");
        fs::create_dir_all(added.parent().expect("added parent")).expect("added directory");
        fs::write(&added, b"int added(void) { return 2; }\n").expect("added source");
        let error = validate_graph_transition_library_source_set(
            std::slice::from_ref(&canonical_library),
            &contract,
        )
        .expect_err("an unlisted deep translation unit must fail closed");
        assert_eq!(error.code, NativeRelinkGateCode::CcdbAmbiguous);
        assert_eq!(
            validate_graph_transition_library_trees(&proof)
                .expect_err("tree proof must detect the added source")
                .code,
            NativeRelinkGateCode::DirtyBuild
        );
    }

    #[test]
    fn graph_transition_properties_are_bom_aware_and_fail_closed() {
        let fixture = Fixture::new("graph-properties");
        let library = fixture.root.join("Library");
        fs::create_dir_all(library.join("src")).expect("library src");
        fs::write(library.join("src/driver.cpp"), b"int driver;\n").expect("driver");
        let contract = transition_contract_with_sources(&library, std::iter::empty());

        fs::write(
            library.join("library.properties"),
            "  \u{feff}dot_a_linkage=true\n".as_bytes(),
        )
        .expect("BOM properties");
        assert_eq!(
            validate_graph_transition_library_source_set(
                std::slice::from_ref(&library),
                &contract,
            )
            .expect_err("BOM must not hide archive semantics")
            .code,
            NativeRelinkGateCode::RecipeMismatch
        );

        fs::write(library.join("library.properties"), [0xff, 0xfe, 0xfd])
            .expect("non-UTF8 properties");
        assert_eq!(
            validate_graph_transition_library_source_set(
                std::slice::from_ref(&library),
                &contract,
            )
            .expect_err("non-UTF8 properties must fail closed")
            .code,
            NativeRelinkGateCode::InvalidManifest
        );
    }

    #[test]
    fn graph_transition_rejects_new_header_collision_and_missing_declared_dependency() {
        let fixture = Fixture::new("graph-closure");
        let first = fixture.root.join("First");
        let second = fixture.root.join("Second");
        for root in [&first, &second] {
            fs::create_dir_all(root.join("src")).expect("library src");
            fs::write(root.join("src/Shared.h"), b"#pragma once\n").expect("shared header");
        }
        fs::write(first.join("library.properties"), b"name=First\n").expect("first properties");
        fs::write(second.join("library.properties"), b"name=Second\n").expect("second properties");
        let contract = transition_contract_with_sources(&first, std::iter::empty());
        assert_eq!(
            validate_graph_transition_library_source_set(&[first.clone(), second], &contract)
                .expect_err("cross-root header collision must fail closed")
                .code,
            NativeRelinkGateCode::CcdbAmbiguous
        );

        fs::remove_file(first.join("src/Shared.h")).expect("remove first collision");
        fs::write(
            first.join("library.properties"),
            b"name=First\ndepends=Missing Bus (>=1.0)\n",
        )
        .expect("declared dependency");
        assert_eq!(
            validate_graph_transition_library_source_set(std::slice::from_ref(&first), &contract,)
                .expect_err("missing declared dependency must fail closed")
                .code,
            NativeRelinkGateCode::CcdbAmbiguous
        );
    }

    #[test]
    fn planned_library_output_preserves_mixed_case_leaf_spelling() {
        let fixture = Fixture::new("planned-output-case");
        let path = fixture.build.join("LiBrArIeS/MixedCase/Deep/Driver.CPP.o");
        let planned = planned_library_output_path(&path, &fixture.build, &fixture.build)
            .expect("case-insensitive containment");
        assert_eq!(
            planned.file_name().and_then(|value| value.to_str()),
            Some("Driver.CPP.o")
        );
        assert!(planned.to_string_lossy().contains("MixedCase"));
    }

    #[test]
    fn graph_transition_core_only_depfile_allows_empty_selected_roots() {
        let fixture = Fixture::new("core-only-depfile");
        let platform_libraries = fixture.root.join("platform/libraries");
        let wire = platform_libraries.join("Wire/src/Wire.h");
        let core = fixture.root.join("platform/cores/arduino/Arduino.h");
        for path in [&wire, &core] {
            fs::create_dir_all(path.parent().expect("header parent")).expect("header directory");
            fs::write(path, b"#pragma once\n").expect("header");
        }
        let depfile = fixture.build.join("core-only.d");
        fs::write(
            &depfile,
            format!(
                "{}: {}\n",
                fixture.build.join("sketch.o").display(),
                core.display()
            ),
        )
        .expect("core-only depfile");
        validate_depfile_selected_library_roots(&depfile, &fixture.build, &[])
            .expect("empty selected roots are valid when no platform library is used");

        fs::write(
            &depfile,
            format!(
                "{}: {}\n",
                fixture.build.join("sketch.o").display(),
                wire.display()
            ),
        )
        .expect("stale Wire depfile");
        assert_eq!(
            validate_depfile_selected_library_roots(&depfile, &fixture.build, &[],)
                .expect_err("core-only transition must reject a stale platform library dependency")
                .code,
            NativeRelinkGateCode::CcdbAmbiguous
        );

        let missing = fixture.root.join("missing-dependency.h");
        fs::write(
            &depfile,
            format!(
                "{}: {}\n",
                fixture.build.join("sketch.o").display(),
                missing.display()
            ),
        )
        .expect("missing dependency depfile");
        assert_eq!(
            validate_depfile_selected_library_roots(&depfile, &fixture.build, &[])
                .expect_err("an uncanonicalizable dependency must fail closed")
                .code,
            NativeRelinkGateCode::MissingFile
        );
    }

    #[cfg(unix)]
    #[test]
    fn managed_file_gate_rejects_symlinked_tools() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new("symlink");
        let real = fixture.tools.join("avr-gcc");
        let linked = fixture.tools.join("linked-gcc");
        symlink(&real, &linked).expect("symlink");
        let error = canonical_regular_file_within(&linked, &[fixture.tools.clone()])
            .expect_err("symlink must be rejected");
        assert_eq!(error.code, NativeRelinkGateCode::UnsafeFilesystemEntry);
    }

    #[cfg(windows)]
    #[test]
    fn managed_file_gate_rejects_junction_ancestor() {
        let fixture = Fixture::new("junction");
        let outside = fixture.root.join("outside");
        let through = fixture.root.join("through-junction");
        fs::create_dir_all(&outside).expect("outside");
        fs::write(outside.join("tool.exe"), b"tool").expect("outside tool");
        junction::create(&outside, &through).expect("create junction");
        let error =
            canonical_regular_file_within(&through.join("tool.exe"), &[fixture.root.clone()])
                .expect_err("junction ancestor must be rejected");
        assert_eq!(error.code, NativeRelinkGateCode::UnsafeFilesystemEntry);
        junction::delete(&through).expect("delete junction");
    }
}
