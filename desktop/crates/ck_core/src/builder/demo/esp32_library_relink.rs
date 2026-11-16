//! Sealed evidence for a future ESP32 library-aware NativeRelink lane.
//!
//! This module is intentionally not wired into the phase-1 product route. It
//! captures and revalidates one native Arduino CLI Release library graph so a
//! later adapter can reuse already-built library objects without guessing
//! source membership, compiler commands, depfiles, or link order. Any missing,
//! ambiguous, reparse-backed, out-of-root, or over-bound input is a clean miss.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub(super) const ESP32_LIBRARY_RELINK_EVIDENCE_CONTRACT: &str =
    "ck-esp32-library-relink-evidence-v4";
const ESP32_LIBRARY_RELINK_MANIFEST_SCHEMA_VERSION: u32 = 4;
const MAX_CCDB_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_CCDB_ENTRIES: usize = 4096;
const MAX_LIBRARY_ROOTS: usize = 16;
const MAX_LIBRARY_OBJECTS: usize = 512;
const MAX_LIBRARY_TREE_DEPTH: usize = 32;
const MAX_LIBRARY_TREE_FILES: usize = 4096;
const MAX_LIBRARY_TREE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ALL_LIBRARY_TREE_FILES: usize = 16_384;
const MAX_ALL_LIBRARY_TREE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_LINK_INPUTS: usize = MAX_LIBRARY_OBJECTS + 1;
const MAX_LINK_ARGV_TOKENS: usize = 4096;
const MAX_LINK_ARGV_BYTES: usize = 1024 * 1024;
const MAX_LINK_TOKEN_BYTES: usize = 32 * 1024;
const MAX_LINK_RESPONSE_FILES: usize = 128;
const MAX_DEPENDENCIES_PER_OBJECT: usize = 4096;
const MAX_CORE_DEPENDENCY_REFERENCES: usize = 262_144;
const MAX_CORE_UNIQUE_DEPENDENCIES: usize = 32_768;
const MAX_RESPONSE_DEPTH: usize = 4;
const MAX_RESPONSE_FILES: usize = 128;
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_OBJECT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DEPFILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_DEPENDENCY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CORE_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CAPTURE_FILE_CACHE_ENTRIES: usize = 32_768;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Esp32LibraryRelinkGateCode {
    InvalidInput,
    BoundExceeded,
    UnsafePath,
    PathEscape,
    MissingEvidence,
    InvalidCcdb,
    AmbiguousGraph,
    UnsupportedLibrarySemantics,
    EvidenceMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Esp32LibraryRelinkGateError {
    pub code: Esp32LibraryRelinkGateCode,
    pub detail: String,
}

impl Esp32LibraryRelinkGateError {
    fn new(code: Esp32LibraryRelinkGateCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for Esp32LibraryRelinkGateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.detail)
    }
}

impl std::error::Error for Esp32LibraryRelinkGateError {}

type GateResult<T> = Result<T, Esp32LibraryRelinkGateError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Esp32LibraryFileEvidence {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// One explicitly selected Arduino library root. The complete bounded tree is
/// sealed independently from depfiles so an unreferenced source/header change
/// cannot inherit authority from an older native Release build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Esp32LibraryRootEvidence {
    pub path: String,
    pub tree_sha256: String,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Esp32LibraryTranslationUnitEvidence {
    pub library_root_index: usize,
    pub source: Esp32LibraryFileEvidence,
    pub object: Esp32LibraryFileEvidence,
    pub depfile: Esp32LibraryFileEvidence,
    pub command_sha256: String,
    pub dependencies: Vec<Esp32LibraryFileEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Esp32SketchTranslationUnitEvidence {
    pub source: Esp32LibraryFileEvidence,
    pub object: Esp32LibraryFileEvidence,
    pub depfile: Esp32LibraryFileEvidence,
    pub command_sha256: String,
    pub dependencies: Vec<Esp32LibraryFileEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Esp32LinkResponseEvidence {
    /// `None` means the token belongs to the sealed top-level linker argv.
    /// Nested response files bind to their canonical parent response path.
    pub parent_path: Option<String>,
    pub token_ordinal: usize,
    pub depth: usize,
    pub raw_token: String,
    pub file: Esp32LibraryFileEvidence,
}

/// The complete direct-process link command emitted by the native Arduino CLI
/// Release build. Response files remain as `@...` argv tokens and are sealed
/// separately so replay cannot silently inherit a changed linker graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Esp32NativeLinkCommandEvidence {
    pub working_directory: String,
    pub argv: Vec<String>,
    pub argv_sha256: String,
    pub executable: Esp32LibraryFileEvidence,
    pub response_files: Vec<Esp32LinkResponseEvidence>,
    pub response_graph_sha256: String,
    pub elf_output: String,
    pub map_output: String,
}

impl Esp32NativeLinkCommandEvidence {
    fn validate_header(&self) -> GateResult<()> {
        if !Path::new(&self.working_directory).is_absolute()
            || self.argv.len() < 2
            || self.argv.len() > MAX_LINK_ARGV_TOKENS
            || !is_sha256(&self.argv_sha256)
            || !is_sha256(&self.executable.sha256)
            || self.response_files.len() > MAX_LINK_RESPONSE_FILES
            || !is_sha256(&self.response_graph_sha256)
            || !Path::new(&self.elf_output).is_absolute()
            || !Path::new(&self.map_output).is_absolute()
        {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::InvalidInput,
                "manifest contains malformed native link-command evidence",
            ));
        }
        let mut argv_bytes = 0usize;
        for token in &self.argv {
            argv_bytes = argv_bytes.checked_add(token.len()).ok_or_else(|| {
                Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::BoundExceeded,
                    "native link argv byte count overflowed",
                )
            })?;
            if token.is_empty()
                || token.len() > MAX_LINK_TOKEN_BYTES
                || token
                    .chars()
                    .any(|value| matches!(value, '\0' | '\r' | '\n'))
                || token.contains('{')
                || token.contains('}')
            {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::InvalidInput,
                    "native link argv contains an empty, unresolved, or over-bound token",
                ));
            }
        }
        if argv_bytes > MAX_LINK_ARGV_BYTES {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::BoundExceeded,
                "native link argv exceeds its bounded byte contract",
            ));
        }
        let mut response_positions = BTreeSet::new();
        for response in &self.response_files {
            let top_level_binding_invalid = response.parent_path.is_none()
                && (response.depth != 0
                    || response.token_ordinal >= self.argv.len()
                    || self.argv[response.token_ordinal] != response.raw_token);
            let nested_binding_invalid = response
                .parent_path
                .as_ref()
                .is_some_and(|parent| response.depth == 0 || !Path::new(parent).is_absolute());
            let position_key = format!(
                "{}\0{}\0{}",
                response.parent_path.as_deref().unwrap_or("<argv>"),
                response.token_ordinal,
                response.depth
            );
            if top_level_binding_invalid
                || nested_binding_invalid
                || response.depth > MAX_RESPONSE_DEPTH
                || !response.raw_token.starts_with('@')
                || response.raw_token.len() < 2
                || !is_sha256(&response.file.sha256)
                || !Path::new(&response.file.path).is_absolute()
                || !response_positions.insert(position_key)
            {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::InvalidInput,
                    "native link response-file evidence is malformed or ambiguous",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Esp32LibraryRelinkManifest {
    pub schema_version: u32,
    pub evidence_contract: String,
    pub canonical_fqbn: String,
    pub build_signature: String,
    pub toolchain_key: String,
    pub property_contract_sha256: String,
    pub canonical_build_dir: String,
    pub project_name: String,
    pub ccdb: Esp32LibraryFileEvidence,
    pub command_graph_sha256: String,
    pub library_roots: Vec<Esp32LibraryRootEvidence>,
    pub sketch: Esp32SketchTranslationUnitEvidence,
    pub library_units: Vec<Esp32LibraryTranslationUnitEvidence>,
    pub core_archive: Esp32LibraryFileEvidence,
    pub native_link: Esp32NativeLinkCommandEvidence,
    /// Exact native `{object_files}` order. The Core archive is separate.
    pub ordered_link_inputs: Vec<String>,
    pub ordered_link_inputs_sha256: String,
}

impl Esp32LibraryRelinkManifest {
    fn validate_header(&self) -> GateResult<()> {
        if self.schema_version != ESP32_LIBRARY_RELINK_MANIFEST_SCHEMA_VERSION
            || self.evidence_contract != ESP32_LIBRARY_RELINK_EVIDENCE_CONTRACT
            || !self.canonical_fqbn.starts_with("esp32:esp32:")
            || self.canonical_fqbn.matches(':').count() < 2
            || self.build_signature.trim().is_empty()
            || self.toolchain_key.trim().is_empty()
            || !is_sha256(&self.property_contract_sha256)
            || self.canonical_build_dir.trim().is_empty()
            || !valid_project_name(&self.project_name)
            || self.library_roots.is_empty()
            || self.library_roots.len() > MAX_LIBRARY_ROOTS
            || self.library_units.is_empty()
            || self.library_units.len() > MAX_LIBRARY_OBJECTS
            || self.ordered_link_inputs.is_empty()
            || self.ordered_link_inputs.len() > MAX_LINK_INPUTS
        {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::InvalidInput,
                "manifest header does not describe a bounded ESP32 library graph",
            ));
        }
        let mut root_paths = BTreeSet::new();
        let mut total_tree_files = 0usize;
        let mut total_tree_bytes = 0u64;
        for root in &self.library_roots {
            if !Path::new(&root.path).is_absolute()
                || !is_sha256(&root.tree_sha256)
                || root.file_count == 0
                || root.file_count > MAX_LIBRARY_TREE_FILES
                || root.total_bytes > MAX_LIBRARY_TREE_BYTES
                || !root_paths.insert(normalized_path(Path::new(&root.path)))
            {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::InvalidInput,
                    "manifest contains malformed or duplicate library-root evidence",
                ));
            }
            total_tree_files = total_tree_files
                .checked_add(root.file_count)
                .ok_or_else(|| {
                    Esp32LibraryRelinkGateError::new(
                        Esp32LibraryRelinkGateCode::BoundExceeded,
                        "manifest library-tree file count overflowed",
                    )
                })?;
            total_tree_bytes = total_tree_bytes
                .checked_add(root.total_bytes)
                .ok_or_else(|| {
                    Esp32LibraryRelinkGateError::new(
                        Esp32LibraryRelinkGateCode::BoundExceeded,
                        "manifest library-tree byte count overflowed",
                    )
                })?;
        }
        if total_tree_files > MAX_ALL_LIBRARY_TREE_FILES
            || total_tree_bytes > MAX_ALL_LIBRARY_TREE_BYTES
        {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::BoundExceeded,
                "manifest aggregate library-tree evidence exceeds its bounds",
            ));
        }
        self.native_link.validate_header()?;
        for value in [
            self.ccdb.sha256.as_str(),
            self.command_graph_sha256.as_str(),
            self.sketch.source.sha256.as_str(),
            self.sketch.object.sha256.as_str(),
            self.sketch.depfile.sha256.as_str(),
            self.sketch.command_sha256.as_str(),
            self.core_archive.sha256.as_str(),
            self.ordered_link_inputs_sha256.as_str(),
        ] {
            if !is_sha256(value) {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::InvalidInput,
                    "manifest contains a malformed SHA-256 field",
                ));
            }
        }
        for unit in &self.library_units {
            if unit.library_root_index >= self.library_roots.len()
                || !is_sha256(&unit.source.sha256)
                || !is_sha256(&unit.object.sha256)
                || !is_sha256(&unit.depfile.sha256)
                || !is_sha256(&unit.command_sha256)
                || unit.dependencies.is_empty()
                || unit.dependencies.len() > MAX_DEPENDENCIES_PER_OBJECT
                || unit
                    .dependencies
                    .iter()
                    .any(|dependency| !is_sha256(&dependency.sha256))
            {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::InvalidInput,
                    "manifest contains a malformed library translation unit",
                ));
            }
        }
        if self.sketch.dependencies.is_empty()
            || self.sketch.dependencies.len() > MAX_DEPENDENCIES_PER_OBJECT
            || self
                .sketch
                .dependencies
                .iter()
                .any(|dependency| !is_sha256(&dependency.sha256))
        {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::InvalidInput,
                "manifest contains malformed sketch dependency evidence",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
pub(super) struct Esp32LibraryRelinkCaptureInput<'a> {
    pub canonical_fqbn: &'a str,
    pub build_signature: &'a str,
    pub toolchain_key: &'a str,
    pub property_contract_sha256: &'a str,
    pub build_dir: &'a Path,
    pub project_name: &'a str,
    pub ccdb_path: &'a Path,
    pub core_archive: &'a Path,
    pub allowed_library_roots: &'a [PathBuf],
    pub allowed_tool_roots: &'a [PathBuf],
    pub allowed_working_roots: &'a [PathBuf],
    pub allowed_dependency_roots: &'a [PathBuf],
    pub allowed_link_response_roots: &'a [PathBuf],
    pub link_working_directory: &'a Path,
    pub link_argv: &'a [String],
    /// Exact object order captured from the native link command, not inferred
    /// from directory or CCDB enumeration order.
    pub ordered_link_inputs: &'a [PathBuf],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ValidatedEsp32LibraryGraph {
    pub sketch_object: PathBuf,
    pub library_objects: Vec<PathBuf>,
    pub ordered_link_inputs: Vec<PathBuf>,
    pub core_archive: PathBuf,
    pub native_link: ValidatedEsp32NativeLinkCommand,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ValidatedEsp32NativeLinkCommand {
    pub working_directory: PathBuf,
    pub executable: PathBuf,
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CcdbEntry {
    #[serde(default)]
    directory: String,
    #[serde(default)]
    arguments: Vec<String>,
    #[serde(default)]
    command: String,
    file: String,
    #[serde(default)]
    output: Option<String>,
}

#[derive(Debug)]
struct CapturedCommand {
    source: PathBuf,
    object: PathBuf,
    depfile: PathBuf,
    command_sha256: String,
    dependencies: Vec<Esp32LibraryFileEvidence>,
}

#[derive(Debug, Clone)]
struct CachedFileEvidence {
    evidence: Esp32LibraryFileEvidence,
    maximum_bytes: u64,
    allow_empty: bool,
    reuse_count: usize,
}

/// Request-local content snapshot used only while one manifest is captured.
/// Reused entries are hashed again at the end of the capture, so memoization
/// cannot hide an in-flight same-size content change.
#[derive(Debug)]
struct CaptureFileEvidenceCache {
    by_path: BTreeMap<String, CachedFileEvidence>,
    complete: bool,
}

impl Default for CaptureFileEvidenceCache {
    fn default() -> Self {
        Self {
            by_path: BTreeMap::new(),
            complete: true,
        }
    }
}

/// Request-local accumulator for Core depfile structure. ESP32 Core depfiles
/// repeat the same SDK headers across many translation units; validating every
/// occurrence independently turns a few hundred files into thousands of
/// Windows canonicalization and reparse-chain walks. Keep every depfile parse
/// and bound, but validate each unique dependency path once at the end of the
/// same manifest capture.
#[derive(Debug, Default)]
struct CoreDependencyStructureProof {
    reference_count: usize,
    paths: BTreeMap<String, PathBuf>,
    depfiles: BTreeMap<String, Esp32LibraryFileEvidence>,
}

#[derive(Debug)]
struct CapturedEsp32LibraryRelinkManifest {
    manifest: Esp32LibraryRelinkManifest,
    file_cache: CaptureFileEvidenceCache,
    core_dependencies: CoreDependencyStructureProof,
    dependency_roots: Vec<PathBuf>,
}

/// One-request proof retained from the complete pre-link refresh. The linker
/// and artifact recipes may run only while this seal is alive, and the updated
/// manifest is released for commit only after every captured byte and path is
/// revalidated. This avoids parsing the CCDB and rebuilding its command graph a
/// third time without turning request-local memoization into trusted evidence.
#[derive(Debug)]
pub(super) struct Esp32LibraryRelinkRefreshSeal {
    captured: CapturedEsp32LibraryRelinkManifest,
    native_link: ValidatedEsp32NativeLinkCommand,
}

impl Esp32LibraryRelinkRefreshSeal {
    pub(super) fn native_link(&self) -> &ValidatedEsp32NativeLinkCommand {
        &self.native_link
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_project_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn normalized_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn hash_framed<'a>(label: &[u8], values: impl IntoIterator<Item = &'a str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(label);
    hasher.update([0]);
    for value in values {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    hex::encode(hasher.finalize())
}

/// Parse one Arduino verbose command without invoking a shell. The accepted
/// grammar is deliberately small: whitespace separators plus balanced single
/// or double quotes. Link recipes that require shell operators are not eligible
/// for NativeRelink and fall back to the native Arduino CLI.
pub(super) fn parse_esp32_native_link_command_line(line: &str) -> GateResult<Vec<String>> {
    if line.len() > MAX_LINK_ARGV_BYTES
        || line
            .chars()
            .any(|value| matches!(value, '\0' | '\r' | '\n'))
    {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::BoundExceeded,
            "native link command exceeds its bounded text contract",
        ));
    }
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quote = None::<char>;
    let mut token_started = false;
    for value in line.chars() {
        if let Some(active_quote) = quote {
            if value == active_quote {
                quote = None;
            } else {
                token.push(value);
            }
            token_started = true;
            continue;
        }
        match value {
            '\'' | '"' => {
                quote = Some(value);
                token_started = true;
            }
            value if value.is_whitespace() => {
                if token_started {
                    if token.is_empty() || token.len() > MAX_LINK_TOKEN_BYTES {
                        return Err(Esp32LibraryRelinkGateError::new(
                            Esp32LibraryRelinkGateCode::InvalidInput,
                            "native link command contains an empty or over-bound token",
                        ));
                    }
                    tokens.push(std::mem::take(&mut token));
                    token_started = false;
                }
            }
            '|' | '&' | ';' | '<' | '>' => {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::UnsupportedLibrarySemantics,
                    "native link command requires shell semantics",
                ));
            }
            _ => {
                token.push(value);
                token_started = true;
            }
        }
    }
    if quote.is_some() {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::InvalidInput,
            "native link command contains an unterminated quote",
        ));
    }
    if token_started {
        if token.is_empty() || token.len() > MAX_LINK_TOKEN_BYTES {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::InvalidInput,
                "native link command contains an empty or over-bound token",
            ));
        }
        tokens.push(token);
    }
    if tokens.is_empty() || tokens.len() > MAX_LINK_ARGV_TOKENS {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::BoundExceeded,
            "native link command token count is outside its bounded contract",
        ));
    }
    Ok(tokens)
}

fn reject_reparse_chain(path: &Path) -> GateResult<()> {
    if !path.is_absolute() {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::UnsafePath,
            format!("path is not absolute: {}", path.display()),
        ));
    }
    let mut current = Some(path);
    while let Some(candidate) = current {
        let metadata = std::fs::symlink_metadata(candidate).map_err(|error| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::MissingEvidence,
                format!("cannot inspect {}: {error}", candidate.display()),
            )
        })?;
        if super::metadata_is_link_or_reparse(&metadata) {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::UnsafePath,
                format!(
                    "path crosses a symlink or reparse point: {}",
                    candidate.display()
                ),
            ));
        }
        current = candidate.parent();
    }
    Ok(())
}

fn canonical_directory(path: &Path, label: &str) -> GateResult<PathBuf> {
    reject_reparse_chain(path)?;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::MissingEvidence,
            format!("{label} is missing: {error}"),
        )
    })?;
    if !metadata.is_dir() || super::metadata_is_link_or_reparse(&metadata) {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::UnsafePath,
            format!("{label} is not an ordinary directory: {}", path.display()),
        ));
    }
    let canonical = std::fs::canonicalize(path).map_err(|error| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::UnsafePath,
            format!("cannot canonicalize {label}: {error}"),
        )
    })?;
    reject_reparse_chain(&canonical)?;
    Ok(canonical)
}

fn canonical_roots(paths: &[PathBuf], label: &str, maximum: usize) -> GateResult<Vec<PathBuf>> {
    if paths.is_empty() || paths.len() > maximum {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::BoundExceeded,
            format!("{label} count is outside 1..={maximum}"),
        ));
    }
    let mut roots = Vec::with_capacity(paths.len());
    let mut seen = BTreeSet::new();
    for path in paths {
        let root = canonical_directory(path, label)?;
        if !seen.insert(normalized_path(&root)) {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::AmbiguousGraph,
                format!("{label} contains a duplicate or aliased root"),
            ));
        }
        roots.push(root);
    }
    Ok(roots)
}

fn bounded_library_tree_files(root: &Path) -> GateResult<Vec<PathBuf>> {
    fn visit(
        root: &Path,
        directory: &Path,
        files: &mut Vec<PathBuf>,
        depth: usize,
    ) -> GateResult<()> {
        if depth > MAX_LIBRARY_TREE_DEPTH {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::BoundExceeded,
                "library tree exceeds the bounded directory depth",
            ));
        }
        let entries = std::fs::read_dir(directory).map_err(|error| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::MissingEvidence,
                format!(
                    "cannot enumerate library directory {}: {error}",
                    directory.display()
                ),
            )
        })?;
        let mut entries = entries
            .map(|entry| {
                entry.map_err(|error| {
                    Esp32LibraryRelinkGateError::new(
                        Esp32LibraryRelinkGateCode::MissingEvidence,
                        format!(
                            "cannot enumerate one library entry below {}: {error}",
                            directory.display()
                        ),
                    )
                })
            })
            .collect::<GateResult<Vec<_>>>()?;
        entries.sort_by(|left, right| {
            normalized_path(&left.path()).cmp(&normalized_path(&right.path()))
        });
        for entry in entries {
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
                Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::MissingEvidence,
                    format!("cannot inspect library entry {}: {error}", path.display()),
                )
            })?;
            if super::metadata_is_link_or_reparse(&metadata) {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::UnsafePath,
                    format!(
                        "library tree contains a symlink or reparse entry: {}",
                        path.display()
                    ),
                ));
            }
            if metadata.is_dir() {
                visit(root, &path, files, depth + 1)?;
            } else if metadata.is_file() {
                let relative = path.strip_prefix(root).map_err(|_| {
                    Esp32LibraryRelinkGateError::new(
                        Esp32LibraryRelinkGateCode::PathEscape,
                        "library tree file escaped its canonical root",
                    )
                })?;
                if relative.components().any(|component| {
                    !matches!(component, Component::Normal(_))
                        || component.as_os_str().to_str().is_none()
                }) {
                    return Err(Esp32LibraryRelinkGateError::new(
                        Esp32LibraryRelinkGateCode::UnsafePath,
                        format!(
                            "library tree contains an unsafe relative path: {}",
                            path.display()
                        ),
                    ));
                }
                files.push(path);
                if files.len() > MAX_LIBRARY_TREE_FILES {
                    return Err(Esp32LibraryRelinkGateError::new(
                        Esp32LibraryRelinkGateCode::BoundExceeded,
                        "library tree exceeds the bounded file count",
                    ));
                }
            } else {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::UnsafePath,
                    format!("library tree contains a non-file entry: {}", path.display()),
                ));
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    visit(root, root, &mut files, 0)?;
    files.sort_by(|left, right| {
        normalized_path(left.strip_prefix(root).unwrap_or(left))
            .cmp(&normalized_path(right.strip_prefix(root).unwrap_or(right)))
    });
    Ok(files)
}

fn capture_library_root_evidence(root: &Path) -> GateResult<Esp32LibraryRootEvidence> {
    let files = bounded_library_tree_files(root)?;
    if files.is_empty() {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::MissingEvidence,
            "selected library root contains no ordinary files",
        ));
    }
    let mut hasher = Sha256::new();
    hasher.update(b"ck-esp32-library-complete-tree-v2\0");
    let mut total_bytes = 0u64;
    for path in &files {
        let relative = path.strip_prefix(root).map_err(|_| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::PathEscape,
                "library file escaped its canonical root during hashing",
            )
        })?;
        let relative = normalized_path(relative);
        let metadata = std::fs::symlink_metadata(path).map_err(|error| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::MissingEvidence,
                format!("cannot inspect library file {}: {error}", path.display()),
            )
        })?;
        if !metadata.is_file() || super::metadata_is_link_or_reparse(&metadata) {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::UnsafePath,
                format!(
                    "library file changed type while hashing: {}",
                    path.display()
                ),
            ));
        }
        total_bytes = total_bytes.checked_add(metadata.len()).ok_or_else(|| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::BoundExceeded,
                "library tree byte count overflowed",
            )
        })?;
        if total_bytes > MAX_LIBRARY_TREE_BYTES {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::BoundExceeded,
                "library tree exceeds the bounded byte count",
            ));
        }
        hasher.update((relative.len() as u64).to_le_bytes());
        hasher.update(relative.as_bytes());
        hasher.update(metadata.len().to_le_bytes());

        let mut file = File::open(path).map_err(|error| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::MissingEvidence,
                format!("cannot read library file {}: {error}", path.display()),
            )
        })?;
        let mut observed = 0u64;
        let mut buffer = [0u8; 32 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|error| {
                Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::MissingEvidence,
                    format!("cannot hash library file {}: {error}", path.display()),
                )
            })?;
            if read == 0 {
                break;
            }
            observed = observed.saturating_add(read as u64);
            if observed > metadata.len() {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::EvidenceMismatch,
                    format!("library file grew while hashing: {}", path.display()),
                ));
            }
            hasher.update(&buffer[..read]);
        }
        if observed != metadata.len() {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::EvidenceMismatch,
                format!("library file changed while hashing: {}", path.display()),
            ));
        }
    }
    Ok(Esp32LibraryRootEvidence {
        path: normalized_path(root),
        tree_sha256: hex::encode(hasher.finalize()),
        file_count: files.len(),
        total_bytes,
    })
}

fn validated_canonical_file(
    path: &Path,
    allowed_roots: &[PathBuf],
    maximum_bytes: u64,
    allow_empty: bool,
    label: &str,
) -> GateResult<(PathBuf, u64)> {
    reject_reparse_chain(path)?;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::MissingEvidence,
            format!("{label} is missing: {} ({error})", path.display()),
        )
    })?;
    if !metadata.is_file() || super::metadata_is_link_or_reparse(&metadata) {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::UnsafePath,
            format!("{label} is not an ordinary file: {}", path.display()),
        ));
    }
    if (!allow_empty && metadata.len() == 0) || metadata.len() > maximum_bytes {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::BoundExceeded,
            format!(
                "{label} size is outside the bounded contract: {} bytes",
                metadata.len()
            ),
        ));
    }
    let canonical = std::fs::canonicalize(path).map_err(|error| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::UnsafePath,
            format!("cannot canonicalize {label}: {error}"),
        )
    })?;
    reject_reparse_chain(&canonical)?;
    if !allowed_roots.iter().any(|root| canonical.starts_with(root)) {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::PathEscape,
            format!(
                "{label} escaped every allowed root: {}",
                canonical.display()
            ),
        ));
    }
    Ok((canonical, metadata.len()))
}

fn capture_canonical_file_evidence(
    canonical: &Path,
    expected_size: u64,
    maximum_bytes: u64,
    label: &str,
) -> GateResult<Esp32LibraryFileEvidence> {
    let mut file = File::open(&canonical).map_err(|error| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::MissingEvidence,
            format!("cannot read {label}: {error}"),
        )
    })?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 32 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::MissingEvidence,
                format!("cannot hash {label}: {error}"),
            )
        })?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > maximum_bytes {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::BoundExceeded,
                format!("{label} changed beyond its byte bound while hashing"),
            ));
        }
        hasher.update(&buffer[..read]);
    }
    if total != expected_size {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::EvidenceMismatch,
            format!("{label} changed while it was being captured"),
        ));
    }
    Ok(Esp32LibraryFileEvidence {
        path: normalized_path(canonical),
        size: total,
        sha256: hex::encode(hasher.finalize()),
    })
}

fn canonical_file(
    path: &Path,
    allowed_roots: &[PathBuf],
    maximum_bytes: u64,
    allow_empty: bool,
    label: &str,
) -> GateResult<(PathBuf, Esp32LibraryFileEvidence)> {
    let (canonical, size) =
        validated_canonical_file(path, allowed_roots, maximum_bytes, allow_empty, label)?;
    let evidence = capture_canonical_file_evidence(&canonical, size, maximum_bytes, label)?;
    Ok((canonical, evidence))
}

fn revalidate_exact_file_evidence(
    expected: &Esp32LibraryFileEvidence,
    maximum_bytes: u64,
    allow_empty: bool,
    label: &str,
) -> GateResult<()> {
    let path = PathBuf::from(&expected.path);
    let parent = path.parent().ok_or_else(|| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::UnsafePath,
            format!("{label} path has no parent directory"),
        )
    })?;
    // Serialized evidence uses a case-folded slash-normalized spelling on
    // Windows. Re-canonicalize its parent before the containment gate so Path's
    // component comparison uses the filesystem's actual spelling rather than
    // treating a drive-letter/case difference as an escape.
    let canonical_parent = canonical_directory(parent, label)?;
    let (_, current) = canonical_file(
        &path,
        &[canonical_parent],
        maximum_bytes,
        allow_empty,
        label,
    )?;
    if &current != expected {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::EvidenceMismatch,
            format!(
                "{label} changed after the complete pre-link refresh: {}",
                path.display()
            ),
        ));
    }
    Ok(())
}

impl CaptureFileEvidenceCache {
    fn remember_captured(
        &mut self,
        canonical: PathBuf,
        evidence: Esp32LibraryFileEvidence,
        maximum_bytes: u64,
        allow_empty: bool,
        label: &str,
    ) -> GateResult<Esp32LibraryFileEvidence> {
        let key = normalized_path(&canonical);
        if let Some(cached) = self.by_path.get_mut(&key) {
            if cached.evidence != evidence {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::EvidenceMismatch,
                    format!("{label} changed during parallel manifest capture"),
                ));
            }
            cached.maximum_bytes = cached.maximum_bytes.min(maximum_bytes);
            cached.allow_empty &= allow_empty;
            cached.reuse_count = cached.reuse_count.saturating_add(1);
            return Ok(cached.evidence.clone());
        }
        if self.by_path.len() < MAX_CAPTURE_FILE_CACHE_ENTRIES {
            self.by_path.insert(
                key,
                CachedFileEvidence {
                    evidence: evidence.clone(),
                    maximum_bytes,
                    allow_empty,
                    reuse_count: 0,
                },
            );
        } else {
            self.complete = false;
        }
        Ok(evidence)
    }

    fn capture(
        &mut self,
        path: &Path,
        allowed_roots: &[PathBuf],
        maximum_bytes: u64,
        allow_empty: bool,
        label: &str,
    ) -> GateResult<(PathBuf, Esp32LibraryFileEvidence)> {
        let (canonical, size) =
            validated_canonical_file(path, allowed_roots, maximum_bytes, allow_empty, label)?;
        let key = normalized_path(&canonical);
        if let Some(cached) = self.by_path.get_mut(&key) {
            if cached.evidence.size != size {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::EvidenceMismatch,
                    format!("{label} changed size during manifest capture"),
                ));
            }
            cached.maximum_bytes = cached.maximum_bytes.min(maximum_bytes);
            cached.allow_empty &= allow_empty;
            cached.reuse_count = cached.reuse_count.saturating_add(1);
            return Ok((canonical, cached.evidence.clone()));
        }

        let evidence = capture_canonical_file_evidence(&canonical, size, maximum_bytes, label)?;
        if self.by_path.len() < MAX_CAPTURE_FILE_CACHE_ENTRIES {
            self.by_path.insert(
                key,
                CachedFileEvidence {
                    evidence: evidence.clone(),
                    maximum_bytes,
                    allow_empty,
                    reuse_count: 0,
                },
            );
        } else {
            self.complete = false;
        }
        Ok((canonical, evidence))
    }

    fn require_complete(&self) -> GateResult<()> {
        if self.complete {
            Ok(())
        } else {
            Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::BoundExceeded,
                "final refresh seal cannot retain every captured file within its bounded cache",
            ))
        }
    }

    fn revalidate_cached(cached: &CachedFileEvidence, label: &str) -> GateResult<()> {
        revalidate_exact_file_evidence(
            &cached.evidence,
            cached.maximum_bytes,
            cached.allow_empty,
            label,
        )
    }

    fn revalidate_reused(&self) -> GateResult<()> {
        let reused = self
            .by_path
            .values()
            .filter(|cached| cached.reuse_count > 0)
            .collect::<Vec<_>>();
        parallel_gate_checks(&reused, |cached| {
            Self::revalidate_cached(cached, "reused manifest evidence")
        })
    }

    fn revalidate_all(&self) -> GateResult<()> {
        self.require_complete()?;
        let cached = self.by_path.values().collect::<Vec<_>>();
        parallel_gate_checks(&cached, |entry| {
            Self::revalidate_cached(entry, "final refresh seal evidence")
        })
    }
}

/// Final refresh validation is intentionally exhaustive, but the evidence is
/// immutable for the duration of this check.  Hashing a Core dependency tree
/// one file at a time makes the safety pass dominate a same-graph edit on
/// Windows, so use a small bounded worker set while preserving deterministic
/// chunk order for the first reported failure.
fn parallel_gate_checks<T>(
    items: &[T],
    check: impl Fn(&T) -> GateResult<()> + Sync,
) -> GateResult<()>
where
    T: Sync,
{
    if items.len() < 2 {
        for item in items {
            check(item)?;
        }
        return Ok(());
    }
    let workers = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .clamp(1, 8)
        .min(items.len());
    if workers == 1 {
        for item in items {
            check(item)?;
        }
        return Ok(());
    }
    let chunk_size = items.len().div_ceil(workers);
    let results = std::thread::scope(|scope| {
        let handles = items
            .chunks(chunk_size)
            .map(|chunk| scope.spawn(|| chunk.iter().try_for_each(&check)))
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| {
                handle.join().unwrap_or_else(|_| {
                    Err(Esp32LibraryRelinkGateError::new(
                        Esp32LibraryRelinkGateCode::EvidenceMismatch,
                        "parallel evidence validation worker panicked",
                    ))
                })
            })
            .collect::<Vec<_>>()
    });
    for result in results {
        result?;
    }
    Ok(())
}

fn parallel_gate_map<T, R>(
    items: &[T],
    map: impl Fn(&T) -> GateResult<R> + Sync,
) -> GateResult<Vec<R>>
where
    T: Sync,
    R: Send,
{
    if items.len() < 2 {
        return items.iter().map(&map).collect();
    }
    let workers = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .clamp(1, 8)
        .min(items.len());
    if workers == 1 {
        return items.iter().map(&map).collect();
    }
    let chunk_size = items.len().div_ceil(workers);
    let chunks = std::thread::scope(|scope| {
        let handles = items
            .chunks(chunk_size)
            .map(|chunk| scope.spawn(|| chunk.iter().map(&map).collect::<GateResult<Vec<R>>>()))
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| {
                handle.join().unwrap_or_else(|_| {
                    Err(Esp32LibraryRelinkGateError::new(
                        Esp32LibraryRelinkGateCode::EvidenceMismatch,
                        "parallel evidence capture worker panicked",
                    ))
                })
            })
            .collect::<Vec<_>>()
    });
    let mut output = Vec::with_capacity(items.len());
    for chunk in chunks {
        output.extend(chunk?);
    }
    Ok(output)
}

fn resolve_path(raw: &str, directory: &Path) -> GateResult<PathBuf> {
    let trimmed = raw.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::InvalidCcdb,
            "CCDB contains an empty path token",
        ));
    }
    let path = PathBuf::from(trimmed);
    Ok(if path.is_absolute() {
        path
    } else {
        directory.join(path)
    })
}

fn output_path(tokens: &[String], directory: &Path) -> GateResult<PathBuf> {
    let positions = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (token == "-o").then_some(index))
        .collect::<Vec<_>>();
    if positions.len() != 1 || positions[0] + 1 >= tokens.len() {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::InvalidCcdb,
            "CCDB command must contain exactly one -o output",
        ));
    }
    resolve_path(&tokens[positions[0] + 1], directory)
}

fn canonical_link_output(path: &Path, build_root: &Path, label: &str) -> GateResult<PathBuf> {
    reject_reparse_chain(path)?;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::MissingEvidence,
            format!("{label} is missing: {} ({error})", path.display()),
        )
    })?;
    if !metadata.is_file() || super::metadata_is_link_or_reparse(&metadata) {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::UnsafePath,
            format!("{label} is not an ordinary file: {}", path.display()),
        ));
    }
    let canonical = std::fs::canonicalize(path).map_err(|error| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::UnsafePath,
            format!("cannot canonicalize {label}: {error}"),
        )
    })?;
    if !canonical.starts_with(build_root) {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::PathEscape,
            format!("{label} escaped the managed build directory"),
        ));
    }
    Ok(canonical)
}

fn parse_native_link_response_tokens(contents: &str) -> GateResult<Vec<String>> {
    if contents.len() as u64 > MAX_RESPONSE_BYTES || contents.contains('\0') {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::BoundExceeded,
            "native link response file exceeds its bounded text contract",
        ));
    }
    // GCC response files treat line breaks as argument separators. Normalize
    // them before using the strict direct-command parser; the parsed argv is
    // never executed through a shell.
    let normalized = contents.replace(['\r', '\n'], " ");
    parse_esp32_native_link_command_line(&normalized)
}

#[derive(Default)]
struct NativeLinkResponseCaptureState {
    total_bytes: u64,
    active_paths: BTreeSet<String>,
    evidence: Vec<Esp32LinkResponseEvidence>,
    hash_parts: Vec<String>,
}

#[allow(clippy::too_many_arguments)]
fn capture_native_link_response(
    raw_token: &str,
    parent_path: Option<&str>,
    token_ordinal: usize,
    depth: usize,
    working_directory: &Path,
    response_roots: &[PathBuf],
    file_cache: &mut CaptureFileEvidenceCache,
    state: &mut NativeLinkResponseCaptureState,
) -> GateResult<()> {
    if depth > MAX_RESPONSE_DEPTH || state.evidence.len() >= MAX_LINK_RESPONSE_FILES {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::BoundExceeded,
            "native link response-file graph exceeds its bounded depth or count",
        ));
    }
    let raw_path = raw_token
        .strip_prefix('@')
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::InvalidInput,
                "native link response token is malformed",
            )
        })?;
    let (canonical, file) = file_cache.capture(
        &resolve_path(raw_path, working_directory)?,
        response_roots,
        MAX_RESPONSE_BYTES,
        false,
        "native link response file",
    )?;
    state.total_bytes = state.total_bytes.checked_add(file.size).ok_or_else(|| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::BoundExceeded,
            "native link response bytes overflowed",
        )
    })?;
    if state.total_bytes > MAX_RESPONSE_BYTES {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::BoundExceeded,
            "native link response graph exceeds its bounded byte contract",
        ));
    }
    let path_key = normalized_path(&canonical);
    if !state.active_paths.insert(path_key.clone()) {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::AmbiguousGraph,
            "native link response graph contains a cycle",
        ));
    }
    let contents = std::fs::read_to_string(&canonical).map_err(|error| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::InvalidInput,
            format!("native link response file is not valid UTF-8: {error}"),
        )
    })?;
    let response_tokens = parse_native_link_response_tokens(&contents)?;
    let parent = parent_path.map(str::to_string);
    state.hash_parts.extend([
        parent.clone().unwrap_or_else(|| "<argv>".into()),
        token_ordinal.to_string(),
        depth.to_string(),
        raw_token.to_string(),
        file.path.clone(),
        file.size.to_string(),
        file.sha256.clone(),
    ]);
    state.evidence.push(Esp32LinkResponseEvidence {
        parent_path: parent,
        token_ordinal,
        depth,
        raw_token: raw_token.to_string(),
        file: file.clone(),
    });
    for (nested_ordinal, token) in response_tokens.iter().enumerate() {
        if token.starts_with('@') {
            capture_native_link_response(
                token,
                Some(&file.path),
                nested_ordinal,
                depth + 1,
                working_directory,
                response_roots,
                file_cache,
                state,
            )?;
            continue;
        }
        if token.contains('@') {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::UnsupportedLibrarySemantics,
                "native link response file contains an unsupported indirect @ token",
            ));
        }
        let lowered = token.to_ascii_lowercase();
        if token == "-o"
            || token.starts_with("-Wl,--Map=")
            || lowered.ends_with(".o")
            || lowered.ends_with(".obj")
            || lowered.ends_with(".a")
        {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::UnsupportedLibrarySemantics,
                "native link response file hides an output, object, or direct archive",
            ));
        }
    }
    state.active_paths.remove(&path_key);
    Ok(())
}

fn capture_native_link_command(
    argv: &[String],
    working_directory: &Path,
    build_root: &Path,
    project_name: &str,
    core_archive: &Path,
    ordered_link_inputs: &[PathBuf],
    tool_roots: &[PathBuf],
    working_roots: &[PathBuf],
    response_roots: &[PathBuf],
    file_cache: &mut CaptureFileEvidenceCache,
) -> GateResult<Esp32NativeLinkCommandEvidence> {
    if argv.len() < 2 || argv.len() > MAX_LINK_ARGV_TOKENS || !valid_project_name(project_name) {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::BoundExceeded,
            "native link argv token count is outside its bounded contract",
        ));
    }
    let working = canonical_directory(working_directory, "native link working directory")?;
    if !working_roots.iter().any(|root| working.starts_with(root)) {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::PathEscape,
            "native link working directory escaped every managed root",
        ));
    }

    let mut executable_path = resolve_path(&argv[0], &working)?;
    #[cfg(windows)]
    if !executable_path.is_file() && executable_path.extension().is_none() {
        let with_exe = executable_path.with_extension("exe");
        if with_exe.is_file() {
            executable_path = with_exe;
        }
    }
    let (_, executable) = file_cache.capture(
        &executable_path,
        tool_roots,
        256 * 1024 * 1024,
        false,
        "native link executable",
    )?;

    let starts = argv
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (token == "-Wl,--start-group").then_some(index))
        .collect::<Vec<_>>();
    let ends = argv
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (token == "-Wl,--end-group").then_some(index))
        .collect::<Vec<_>>();
    if starts.len() != 1 || ends.len() != 1 || starts[0] >= ends[0] {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::AmbiguousGraph,
            "native link argv has ambiguous group boundaries",
        ));
    }
    let canonical_core = std::fs::canonicalize(core_archive).map_err(|error| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::MissingEvidence,
            format!("native link Core archive is unavailable: {error}"),
        )
    })?;
    let core_indices = argv
        .iter()
        .enumerate()
        .filter_map(|(index, token)| {
            resolve_path(token, &working)
                .ok()
                .and_then(|path| std::fs::canonicalize(path).ok())
                .filter(|path| normalized_path(path) == normalized_path(&canonical_core))
                .map(|_| index)
        })
        .collect::<Vec<_>>();
    if core_indices.len() != 1 || core_indices[0] <= starts[0] || core_indices[0] >= ends[0] {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::AmbiguousGraph,
            "native link argv has no unique Core archive inside its group",
        ));
    }
    let core_index = core_indices[0];
    let observed_objects = argv[starts[0] + 1..core_index]
        .iter()
        .map(|token| {
            let path = resolve_path(token, &working)?;
            std::fs::canonicalize(&path).map_err(|error| {
                Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::MissingEvidence,
                    format!(
                        "native link object is unavailable: {} ({error})",
                        path.display()
                    ),
                )
            })
        })
        .collect::<GateResult<Vec<_>>>()?;
    let expected_objects = ordered_link_inputs
        .iter()
        .map(|path| std::fs::canonicalize(path))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::MissingEvidence,
                format!("ordered native link input is unavailable: {error}"),
            )
        })?;
    if observed_objects
        .iter()
        .map(|path| normalized_path(path))
        .collect::<Vec<_>>()
        != expected_objects
            .iter()
            .map(|path| normalized_path(path))
            .collect::<Vec<_>>()
    {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::AmbiguousGraph,
            "native link argv object order differs from the sealed object graph",
        ));
    }
    if argv[..starts[0]]
        .iter()
        .chain(argv[core_index + 1..].iter())
        .any(|token| {
            let lowered = token.to_ascii_lowercase();
            lowered.ends_with(".o") || lowered.ends_with(".obj") || lowered.ends_with(".a")
        })
    {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::AmbiguousGraph,
            "native link argv contains an object outside the sealed object/Core boundary",
        ));
    }

    let output_positions = argv
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (token == "-o").then_some(index))
        .collect::<Vec<_>>();
    if output_positions.len() != 1 || output_positions[0] + 1 >= argv.len() {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::AmbiguousGraph,
            "native link argv must contain exactly one -o ELF binding",
        ));
    }
    let elf = canonical_link_output(
        &resolve_path(&argv[output_positions[0] + 1], &working)?,
        build_root,
        "native link ELF output",
    )?;
    let map_tokens = argv
        .iter()
        .filter_map(|token| token.strip_prefix("-Wl,--Map="))
        .collect::<Vec<_>>();
    if map_tokens.len() != 1 {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::AmbiguousGraph,
            "native link argv must contain exactly one -Wl,--Map= binding",
        ));
    }
    let map = canonical_link_output(
        &resolve_path(map_tokens[0], &working)?,
        build_root,
        "native link MAP output",
    )?;
    let expected_elf = build_root.join(format!("{project_name}.elf"));
    let expected_map = build_root.join(format!("{project_name}.map"));
    if normalized_path(&elf) != normalized_path(&expected_elf)
        || normalized_path(&map) != normalized_path(&expected_map)
    {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::AmbiguousGraph,
            "native link ELF/MAP outputs do not match the active project name",
        ));
    }
    let elf_stem = elf
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::InvalidInput,
                "native link ELF output has no UTF-8 stem",
            )
        })?;
    let map_stem = map
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::InvalidInput,
                "native link MAP output has no UTF-8 stem",
            )
        })?;
    if elf_stem != map_stem {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::AmbiguousGraph,
            "native link ELF and MAP outputs do not bind the same project",
        ));
    }

    let mut response_state = NativeLinkResponseCaptureState::default();
    for (argv_index, raw_token) in argv.iter().enumerate() {
        if !raw_token.starts_with('@') {
            if raw_token.contains('@') {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::UnsupportedLibrarySemantics,
                    "native link argv contains an unsupported indirect @ token",
                ));
            }
            continue;
        }
        capture_native_link_response(
            raw_token,
            None,
            argv_index,
            0,
            &working,
            response_roots,
            file_cache,
            &mut response_state,
        )?;
    }
    let argv_sha256 = hash_framed(
        b"ck-esp32-library-native-link-argv-v1",
        argv.iter().map(String::as_str),
    );
    let response_graph_sha256 = hash_framed(
        b"ck-esp32-library-native-link-response-graph-v1",
        response_state.hash_parts.iter().map(String::as_str),
    );
    let evidence = Esp32NativeLinkCommandEvidence {
        working_directory: normalized_path(&working),
        argv: argv.to_vec(),
        argv_sha256,
        executable,
        response_files: response_state.evidence,
        response_graph_sha256,
        elf_output: normalized_path(&elf),
        map_output: normalized_path(&map),
    };
    evidence.validate_header()?;
    Ok(evidence)
}

fn library_root_index(path: &Path, roots: &[PathBuf]) -> GateResult<Option<usize>> {
    let matches = roots
        .iter()
        .enumerate()
        .filter_map(|(index, root)| path.starts_with(root).then_some(index))
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => Ok(None),
        [index] => Ok(Some(*index)),
        _ => Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::AmbiguousGraph,
            format!(
                "source belongs to overlapping library roots: {}",
                path.display()
            ),
        )),
    }
}

fn first_relative_component(path: &Path, root: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()?
        .components()
        .find_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
}

fn reject_unsupported_library_semantics(root: &Path) -> GateResult<()> {
    let properties = root.join("library.properties");
    let Ok(contents) = std::fs::read_to_string(&properties) else {
        return Ok(());
    };
    for line in contents.lines() {
        let Some((raw_key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = raw_key.trim().to_ascii_lowercase();
        let value = raw_value.trim();
        let unsupported = match key.as_str() {
            "dot_a_linkage" => !value.is_empty() && !value.eq_ignore_ascii_case("false"),
            "precompiled" => !value.is_empty() && !value.eq_ignore_ascii_case("false"),
            "ldflags" => !value.is_empty(),
            _ => false,
        };
        if unsupported {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::UnsupportedLibrarySemantics,
                format!(
                    "library {} requires Arduino archive/precompiled/link semantics via {key}",
                    root.display()
                ),
            ));
        }
    }
    Ok(())
}

#[derive(Default)]
struct ResponseExpansionState {
    total_bytes: u64,
    file_count: usize,
    stack: BTreeSet<String>,
    evidence: Vec<Esp32LibraryFileEvidence>,
    tokens: Vec<String>,
}

fn expand_response_tokens(
    tokens: &[String],
    directory: &Path,
    allowed_roots: &[PathBuf],
    depth: usize,
    file_cache: &mut CaptureFileEvidenceCache,
    state: &mut ResponseExpansionState,
) -> GateResult<()> {
    if depth > MAX_RESPONSE_DEPTH {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::BoundExceeded,
            "CCDB response-file nesting exceeds the bounded contract",
        ));
    }
    for token in tokens {
        let Some(raw_response) = token.strip_prefix('@') else {
            state.tokens.push(token.clone());
            continue;
        };
        state.file_count += 1;
        if state.file_count > MAX_RESPONSE_FILES {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::BoundExceeded,
                "CCDB response-file count exceeds the bounded contract",
            ));
        }
        let response_path = resolve_path(raw_response, directory)?;
        let remaining = MAX_RESPONSE_BYTES.saturating_sub(state.total_bytes);
        let (canonical, evidence) = file_cache.capture(
            &response_path,
            allowed_roots,
            remaining,
            true,
            "CCDB response file",
        )?;
        state.total_bytes = state.total_bytes.saturating_add(evidence.size);
        let key = evidence.path.clone();
        if !state.stack.insert(key.clone()) {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::InvalidCcdb,
                "CCDB response-file cycle detected",
            ));
        }
        let bytes = std::fs::read(&canonical).map_err(|error| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::MissingEvidence,
                format!("cannot read CCDB response file: {error}"),
            )
        })?;
        let text = std::str::from_utf8(&bytes).map_err(|_| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::InvalidCcdb,
                "CCDB response file is not UTF-8",
            )
        })?;
        state.evidence.push(evidence);
        let nested = super::split_command_line_simple(text);
        expand_response_tokens(
            &nested,
            canonical.parent().unwrap_or(directory),
            allowed_roots,
            depth + 1,
            file_cache,
            state,
        )?;
        state.stack.remove(&key);
    }
    Ok(())
}

fn capture_dependencies(
    depfile_path: &Path,
    directory: &Path,
    allowed_dependency_roots: &[PathBuf],
    file_cache: &mut CaptureFileEvidenceCache,
) -> GateResult<(Esp32LibraryFileEvidence, Vec<Esp32LibraryFileEvidence>)> {
    let (_, depfile) = file_cache.capture(
        depfile_path,
        allowed_dependency_roots,
        MAX_DEPFILE_BYTES,
        false,
        "CCDB depfile",
    )?;
    let contents = std::fs::read_to_string(depfile_path).map_err(|error| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::MissingEvidence,
            format!("cannot read CCDB depfile: {error}"),
        )
    })?;
    let parsed = super::parse_make_dependency_paths(&contents);
    if parsed.is_empty() || parsed.len() > MAX_DEPENDENCIES_PER_OBJECT {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::InvalidCcdb,
            "CCDB depfile dependency count is outside the bounded contract",
        ));
    }
    let mut dependencies = BTreeMap::<String, Esp32LibraryFileEvidence>::new();
    for dependency in parsed {
        let path = if dependency.is_absolute() {
            dependency
        } else {
            directory.join(dependency)
        };
        let (_, evidence) = file_cache.capture(
            &path,
            allowed_dependency_roots,
            MAX_DEPENDENCY_BYTES,
            true,
            "compiler dependency",
        )?;
        dependencies
            .entry(evidence.path.clone())
            .or_insert(evidence);
    }
    if dependencies.is_empty() {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::MissingEvidence,
            "CCDB depfile did not prove any ordinary dependency files",
        ));
    }
    Ok((depfile, dependencies.into_values().collect()))
}

impl CoreDependencyStructureProof {
    fn record_depfile(
        &mut self,
        depfile_path: &Path,
        directory: &Path,
        allowed_dependency_roots: &[PathBuf],
    ) -> GateResult<PathBuf> {
        let (depfile, expected_size) = validated_canonical_file(
            depfile_path,
            allowed_dependency_roots,
            MAX_DEPFILE_BYTES,
            false,
            "Core CCDB depfile",
        )?;
        let contents = std::fs::read_to_string(&depfile).map_err(|error| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::MissingEvidence,
                format!("cannot read Core CCDB depfile: {error}"),
            )
        })?;
        if contents.len() as u64 != expected_size {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::EvidenceMismatch,
                "Core CCDB depfile changed while it was being validated",
            ));
        }
        let depfile_evidence = Esp32LibraryFileEvidence {
            path: normalized_path(&depfile),
            size: expected_size,
            sha256: hex::encode(Sha256::digest(contents.as_bytes())),
        };
        if let Some(previous) = self.depfiles.get(&depfile_evidence.path) {
            if previous != &depfile_evidence {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::EvidenceMismatch,
                    "Core CCDB depfile changed during manifest capture",
                ));
            }
        } else {
            self.depfiles
                .insert(depfile_evidence.path.clone(), depfile_evidence);
        }
        let parsed = super::parse_make_dependency_paths(&contents);
        if parsed.is_empty() || parsed.len() > MAX_DEPENDENCIES_PER_OBJECT {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::InvalidCcdb,
                "Core CCDB depfile dependency count is outside the bounded contract",
            ));
        }
        self.reference_count = self
            .reference_count
            .checked_add(parsed.len())
            .ok_or_else(|| {
                Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::BoundExceeded,
                    "aggregate Core dependency reference count overflowed",
                )
            })?;
        if self.reference_count > MAX_CORE_DEPENDENCY_REFERENCES {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::BoundExceeded,
                "aggregate Core dependency reference count exceeds its bound",
            ));
        }
        for dependency in parsed {
            let path = if dependency.is_absolute() {
                dependency
            } else {
                directory.join(dependency)
            };
            let key = normalized_path(&path);
            if !self.paths.contains_key(&key) && self.paths.len() >= MAX_CORE_UNIQUE_DEPENDENCIES {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::BoundExceeded,
                    "unique Core dependency path count exceeds its bound",
                ));
            }
            self.paths.entry(key).or_insert(path);
        }
        Ok(depfile)
    }

    fn validate_unique_dependencies(&self, allowed_dependency_roots: &[PathBuf]) -> GateResult<()> {
        for path in self.paths.values() {
            validated_canonical_file(
                path,
                allowed_dependency_roots,
                MAX_DEPENDENCY_BYTES,
                true,
                "Core compiler dependency",
            )?;
        }
        Ok(())
    }

    fn capture_unique_dependency_content(
        &self,
        allowed_dependency_roots: &[PathBuf],
        file_cache: &mut CaptureFileEvidenceCache,
    ) -> GateResult<String> {
        let mut parts = Vec::with_capacity(self.paths.len().saturating_mul(3));
        let paths = self.paths.values().collect::<Vec<_>>();
        let captured = parallel_gate_map(&paths, |path| {
            canonical_file(
                path,
                allowed_dependency_roots,
                MAX_DEPENDENCY_BYTES,
                true,
                "Core compiler dependency",
            )
        })?;
        for (canonical, evidence) in captured {
            let evidence = file_cache.remember_captured(
                canonical,
                evidence,
                MAX_DEPENDENCY_BYTES,
                true,
                "Core compiler dependency",
            )?;
            parts.extend([evidence.path, evidence.size.to_string(), evidence.sha256]);
        }
        if parts.is_empty() {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::MissingEvidence,
                "Core CCDB depfiles did not prove any unique dependency files",
            ));
        }
        Ok(hash_framed(
            b"ck-esp32-library-core-dependency-content-v1",
            parts.iter().map(String::as_str),
        ))
    }

    fn revalidate_final(&self, allowed_dependency_roots: &[PathBuf]) -> GateResult<()> {
        let depfiles = self.depfiles.values().collect::<Vec<_>>();
        parallel_gate_checks(&depfiles, |depfile| {
            revalidate_exact_file_evidence(
                depfile,
                MAX_DEPFILE_BYTES,
                false,
                "final Core CCDB depfile evidence",
            )
        })?;
        let dependencies = self.paths.values().collect::<Vec<_>>();
        parallel_gate_checks(&dependencies, |path| {
            validated_canonical_file(
                path,
                allowed_dependency_roots,
                MAX_DEPENDENCY_BYTES,
                true,
                "Core compiler dependency",
            )
            .map(|_| ())
        })
    }
}

fn validate_dependencies_without_content_evidence(
    depfile_path: &Path,
    directory: &Path,
    allowed_dependency_roots: &[PathBuf],
    proof: &mut CoreDependencyStructureProof,
) -> GateResult<PathBuf> {
    proof.record_depfile(depfile_path, directory, allowed_dependency_roots)
}

fn capture_command(
    entry: &CcdbEntry,
    build_root: &Path,
    source_roots: &[PathBuf],
    tool_roots: &[PathBuf],
    working_roots: &[PathBuf],
    response_roots: &[PathBuf],
    dependency_roots: &[PathBuf],
    file_cache: &mut CaptureFileEvidenceCache,
    core_dependencies: &mut CoreDependencyStructureProof,
    working_directory_cache: &mut BTreeMap<String, (PathBuf, PathBuf)>,
    compiler_cache: &mut BTreeMap<String, (PathBuf, Esp32LibraryFileEvidence)>,
) -> GateResult<CapturedCommand> {
    if entry.arguments.is_empty() || !entry.command.trim().is_empty() {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::InvalidCcdb,
            "ESP32 library evidence requires an arguments-form CCDB command",
        ));
    }
    let raw_directory = PathBuf::from(entry.directory.trim());
    let raw_directory_key = normalized_path(&raw_directory);
    let directory = if let Some((_, canonical)) = working_directory_cache.get(&raw_directory_key) {
        canonical.clone()
    } else {
        let canonical = canonical_directory(&raw_directory, "CCDB working directory")?;
        working_directory_cache.insert(
            raw_directory_key,
            (raw_directory.clone(), canonical.clone()),
        );
        canonical
    };
    if !working_roots.iter().any(|root| directory.starts_with(root)) {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::PathEscape,
            format!(
                "CCDB working directory escaped managed roots: {}",
                directory.display()
            ),
        ));
    }
    let mut expansion = ResponseExpansionState::default();
    expand_response_tokens(
        &entry.arguments,
        &directory,
        response_roots,
        0,
        file_cache,
        &mut expansion,
    )?;
    if expansion.tokens.len() < 4 || !expansion.tokens.iter().any(|token| token == "-c") {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::InvalidCcdb,
            "CCDB row is not a direct compile command",
        ));
    }
    let mut compiler = resolve_path(&expansion.tokens[0], &directory)?;
    // Arduino's Windows CCDB commonly records the exact absolute compiler
    // path without the executable suffix even though the ordinary file is
    // `<same path>.exe`. Match the existing AVR NativeRelink rule narrowly:
    // never search PATH or another directory, and let the managed tool-root
    // gate below authenticate the resolved file.
    #[cfg(windows)]
    if !compiler.is_file() && compiler.extension().is_none() {
        let with_exe = compiler.with_extension("exe");
        if with_exe.is_file() {
            compiler = with_exe;
        }
    }
    let compiler_key = normalized_path(&compiler);
    if !compiler_cache.contains_key(&compiler_key) {
        let (_, evidence) = file_cache.capture(
            &compiler,
            tool_roots,
            256 * 1024 * 1024,
            false,
            "CCDB compiler",
        )?;
        compiler_cache.insert(compiler_key, (compiler.clone(), evidence));
    }

    let raw_source = resolve_path(&entry.file, &directory)?;
    let (source, _) = validated_canonical_file(
        &raw_source,
        source_roots,
        MAX_SOURCE_BYTES,
        false,
        "CCDB source",
    )?;
    let source_extension = source.extension().and_then(|value| value.to_str());
    let source_token_count = expansion
        .tokens
        .iter()
        .filter(|token| !token.starts_with('-'))
        .filter_map(|token| resolve_path(token, &directory).ok())
        // A compile row can contain dozens of include/search paths. Only
        // source-shaped tokens can name the translation unit; canonicalizing
        // every flag path made one ESP32 edit perform thousands of redundant
        // filesystem and reparse walks. Candidate tokens still receive the
        // same canonical identity comparison, and an unusual spelling that
        // cannot be proven simply fails closed below.
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| {
                    source_extension
                        .is_some_and(|expected| extension.eq_ignore_ascii_case(expected))
                })
        })
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .filter(|path| normalized_path(path) == normalized_path(&source))
        .count();
    if source_token_count != 1 {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::AmbiguousGraph,
            format!(
                "CCDB command must name its source exactly once: {}",
                source.display()
            ),
        ));
    }

    let raw_object = output_path(&expansion.tokens, &directory)?;
    let build_roots = [build_root.to_path_buf()];
    let (object, _) = validated_canonical_file(
        &raw_object,
        &build_roots,
        MAX_OBJECT_BYTES,
        false,
        "CCDB object",
    )?;
    if let Some(declared) = entry
        .output
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let declared = resolve_path(declared, &directory)?;
        let declared = std::fs::canonicalize(&declared).map_err(|error| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::MissingEvidence,
                format!("CCDB declared output is missing: {error}"),
            )
        })?;
        if normalized_path(&declared) != normalized_path(&object) {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::AmbiguousGraph,
                "CCDB output field differs from the command -o output",
            ));
        }
    }

    let depfile_path = object.with_extension("d");
    let is_core_row = first_relative_component(&object, build_root).as_deref() == Some("core");
    let (depfile, dependencies) = if is_core_row {
        (
            validate_dependencies_without_content_evidence(
                &depfile_path,
                &directory,
                dependency_roots,
                core_dependencies,
            )?,
            Vec::new(),
        )
    } else {
        // Sketch/library rows are replay inputs. Seal their bytes and complete
        // transitive dependency contents; Core rows reuse only the separately
        // sealed core.a and therefore need structural validation, not discarded
        // source/object/header hashes.
        file_cache.capture(
            &source,
            source_roots,
            MAX_SOURCE_BYTES,
            false,
            "CCDB source",
        )?;
        file_cache.capture(
            &object,
            &build_roots,
            MAX_OBJECT_BYTES,
            false,
            "CCDB object",
        )?;
        let (depfile, dependencies) =
            capture_dependencies(&depfile_path, &directory, dependency_roots, file_cache)?;
        (PathBuf::from(depfile.path), dependencies)
    };
    let mut command_parts = Vec::<String>::new();
    command_parts.push(normalized_path(&directory));
    command_parts.push(entry.file.clone());
    command_parts.push(entry.output.clone().unwrap_or_default());
    command_parts.extend(entry.arguments.iter().cloned());
    for response in expansion.evidence {
        command_parts.push(response.path);
        command_parts.push(response.size.to_string());
        command_parts.push(response.sha256);
    }
    let command_sha256 = hash_framed(
        b"ck-esp32-library-ccdb-command-v1",
        command_parts.iter().map(String::as_str),
    );
    Ok(CapturedCommand {
        source,
        object,
        depfile,
        command_sha256,
        dependencies,
    })
}

fn capture_file_evidence_from_canonical(
    path: &Path,
    roots: &[PathBuf],
    maximum: u64,
    label: &str,
    file_cache: &mut CaptureFileEvidenceCache,
) -> GateResult<Esp32LibraryFileEvidence> {
    file_cache
        .capture(path, roots, maximum, false, label)
        .map(|(_, evidence)| evidence)
}

fn capture_esp32_library_relink_manifest_with_receipt(
    input: Esp32LibraryRelinkCaptureInput<'_>,
) -> GateResult<CapturedEsp32LibraryRelinkManifest> {
    if !input.canonical_fqbn.starts_with("esp32:esp32:")
        || input.build_signature.trim().is_empty()
        || input.toolchain_key.trim().is_empty()
        || !is_sha256(input.property_contract_sha256)
    {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::InvalidInput,
            "capture identity is incomplete or is not ESP32",
        ));
    }
    let build_root = canonical_directory(input.build_dir, "ESP32 build directory")?;
    let library_roots = canonical_roots(
        input.allowed_library_roots,
        "library root",
        MAX_LIBRARY_ROOTS,
    )?;
    for root in &library_roots {
        reject_unsupported_library_semantics(root)?;
    }
    let mut library_root_evidence = Vec::with_capacity(library_roots.len());
    let mut total_tree_files = 0usize;
    let mut total_tree_bytes = 0u64;
    for root in &library_roots {
        let evidence = capture_library_root_evidence(root)?;
        total_tree_files = total_tree_files
            .checked_add(evidence.file_count)
            .ok_or_else(|| {
                Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::BoundExceeded,
                    "aggregate library-tree file count overflowed",
                )
            })?;
        total_tree_bytes = total_tree_bytes
            .checked_add(evidence.total_bytes)
            .ok_or_else(|| {
                Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::BoundExceeded,
                    "aggregate library-tree byte count overflowed",
                )
            })?;
        if total_tree_files > MAX_ALL_LIBRARY_TREE_FILES
            || total_tree_bytes > MAX_ALL_LIBRARY_TREE_BYTES
        {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::BoundExceeded,
                "aggregate library-tree evidence exceeds its bounds",
            ));
        }
        library_root_evidence.push(evidence);
    }
    let tool_roots = canonical_roots(input.allowed_tool_roots, "tool root", 32)?;
    let working_roots = canonical_roots(input.allowed_working_roots, "working root", 32)?;
    let link_response_roots = canonical_roots(
        input.allowed_link_response_roots,
        "native link response root",
        32,
    )?;
    let mut dependency_roots =
        canonical_roots(input.allowed_dependency_roots, "dependency root", 64)?;
    for root in std::iter::once(&build_root)
        .chain(library_roots.iter())
        .chain(tool_roots.iter())
    {
        if !dependency_roots
            .iter()
            .any(|existing| normalized_path(existing) == normalized_path(root))
        {
            dependency_roots.push(root.clone());
        }
    }
    let mut source_roots = dependency_roots.clone();
    if !source_roots
        .iter()
        .any(|root| normalized_path(root) == normalized_path(&build_root))
    {
        source_roots.push(build_root.clone());
    }
    let mut response_roots = dependency_roots.clone();
    response_roots.extend(tool_roots.iter().cloned());
    let mut file_cache = CaptureFileEvidenceCache::default();

    let (ccdb_path, ccdb) = file_cache.capture(
        input.ccdb_path,
        std::slice::from_ref(&build_root),
        MAX_CCDB_BYTES,
        false,
        "compile_commands.json",
    )?;
    let raw = std::fs::read_to_string(&ccdb_path).map_err(|error| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::InvalidCcdb,
            format!("cannot read compile_commands.json: {error}"),
        )
    })?;
    let entries: Vec<CcdbEntry> = serde_json::from_str(&raw).map_err(|error| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::InvalidCcdb,
            format!("compile_commands.json is invalid: {error}"),
        )
    })?;
    if entries.is_empty() || entries.len() > MAX_CCDB_ENTRIES {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::BoundExceeded,
            "CCDB entry count is outside the bounded contract",
        ));
    }

    let mut graph_parts = Vec::<String>::new();
    let mut sketch = None::<Esp32SketchTranslationUnitEvidence>;
    let mut library_units = Vec::<Esp32LibraryTranslationUnitEvidence>::new();
    let mut source_owners = BTreeMap::<String, String>::new();
    let mut object_owners = BTreeMap::<String, String>::new();
    let mut proven_library_roots = BTreeSet::<usize>::new();
    let mut core_rows = 0usize;
    let mut core_dependencies = CoreDependencyStructureProof::default();
    let mut working_directory_cache = BTreeMap::<String, (PathBuf, PathBuf)>::new();
    let mut compiler_cache = BTreeMap::<String, (PathBuf, Esp32LibraryFileEvidence)>::new();
    for entry in &entries {
        let command = capture_command(
            entry,
            &build_root,
            &source_roots,
            &tool_roots,
            &working_roots,
            &response_roots,
            &dependency_roots,
            &mut file_cache,
            &mut core_dependencies,
            &mut working_directory_cache,
            &mut compiler_cache,
        )?;
        let source_key = normalized_path(&command.source);
        let object_key = normalized_path(&command.object);
        if let Some(previous) = source_owners.insert(source_key.clone(), object_key.clone())
            && previous != object_key
        {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::AmbiguousGraph,
                "one CCDB source maps to multiple objects",
            ));
        }
        if let Some(previous) = object_owners.insert(object_key.clone(), source_key.clone())
            && previous != source_key
        {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::AmbiguousGraph,
                "one CCDB object has multiple source owners",
            ));
        }
        graph_parts.extend([
            source_key.clone(),
            object_key.clone(),
            command.command_sha256.clone(),
        ]);

        let first_component = first_relative_component(&command.object, &build_root);
        if first_component.as_deref() == Some("sketch")
            && command
                .source
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(".ino.cpp")
        {
            if sketch.is_some() {
                return Err(Esp32LibraryRelinkGateError::new(
                    Esp32LibraryRelinkGateCode::AmbiguousGraph,
                    "CCDB contains more than one sketch translation unit",
                ));
            }
            let source = capture_file_evidence_from_canonical(
                &command.source,
                &source_roots,
                MAX_SOURCE_BYTES,
                "sketch source",
                &mut file_cache,
            )?;
            let object = capture_file_evidence_from_canonical(
                &command.object,
                std::slice::from_ref(&build_root),
                MAX_OBJECT_BYTES,
                "sketch object",
                &mut file_cache,
            )?;
            let depfile = capture_file_evidence_from_canonical(
                &command.depfile,
                std::slice::from_ref(&build_root),
                MAX_DEPFILE_BYTES,
                "sketch depfile",
                &mut file_cache,
            )?;
            sketch = Some(Esp32SketchTranslationUnitEvidence {
                source,
                object,
                depfile,
                command_sha256: command.command_sha256,
                dependencies: command.dependencies,
            });
            continue;
        }
        if first_component.as_deref() == Some("core") {
            core_rows += 1;
            continue;
        }
        let root_index = library_root_index(&command.source, &library_roots)?.ok_or_else(|| {
            Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::PathEscape,
                format!(
                    "non-Core CCDB source is outside every admitted library root: {}",
                    command.source.display()
                ),
            )
        })?;
        if first_component.as_deref() != Some("libraries") {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::PathEscape,
                format!(
                    "library source does not map to build/libraries: {}",
                    command.object.display()
                ),
            ));
        }
        if library_units.len() >= MAX_LIBRARY_OBJECTS {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::BoundExceeded,
                "library translation-unit count exceeds the bounded contract",
            ));
        }
        for dependency in &command.dependencies {
            let dependency_path = PathBuf::from(&dependency.path);
            if let Some(index) = library_root_index(&dependency_path, &library_roots)? {
                proven_library_roots.insert(index);
            }
        }
        proven_library_roots.insert(root_index);
        library_units.push(Esp32LibraryTranslationUnitEvidence {
            library_root_index: root_index,
            source: capture_file_evidence_from_canonical(
                &command.source,
                std::slice::from_ref(&library_roots[root_index]),
                MAX_SOURCE_BYTES,
                "library source",
                &mut file_cache,
            )?,
            object: capture_file_evidence_from_canonical(
                &command.object,
                std::slice::from_ref(&build_root),
                MAX_OBJECT_BYTES,
                "library object",
                &mut file_cache,
            )?,
            depfile: capture_file_evidence_from_canonical(
                &command.depfile,
                std::slice::from_ref(&build_root),
                MAX_DEPFILE_BYTES,
                "library depfile",
                &mut file_cache,
            )?,
            command_sha256: command.command_sha256,
            dependencies: command.dependencies,
        });
    }
    // Hundreds of ESP32 Core CCDB rows normally repeat one working directory
    // and one compiler. Validate each unique identity once during capture and
    // once again at the capture boundary, rather than re-running the complete
    // Windows reparse chain for every row. No command is authorized between
    // these checks and the exhaustive manifest comparison below.
    let working_directories = working_directory_cache.values().collect::<Vec<_>>();
    parallel_gate_checks(&working_directories, |(raw, expected)| {
        let current = canonical_directory(raw, "reused CCDB working directory")?;
        if &current != expected {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::EvidenceMismatch,
                "CCDB working directory identity changed during manifest capture",
            ));
        }
        Ok(())
    })?;
    let compilers = compiler_cache.values().collect::<Vec<_>>();
    parallel_gate_checks(&compilers, |(raw, expected)| {
        let (_, current) = canonical_file(
            raw,
            &tool_roots,
            256 * 1024 * 1024,
            false,
            "reused CCDB compiler",
        )?;
        if &current != expected {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::EvidenceMismatch,
                "CCDB compiler identity changed during manifest capture",
            ));
        }
        Ok(())
    })?;
    let sketch = sketch.ok_or_else(|| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::InvalidCcdb,
            "CCDB has no unique sketch translation unit",
        )
    })?;
    if core_rows == 0 || library_units.is_empty() {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::InvalidCcdb,
            "CCDB must contain Core and library translation units",
        ));
    }
    if proven_library_roots.len() != library_roots.len() {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::AmbiguousGraph,
            "an admitted library root is not proven by a selected source or depfile",
        ));
    }
    let core_dependency_content_sha256 =
        core_dependencies.capture_unique_dependency_content(&dependency_roots, &mut file_cache)?;
    graph_parts.extend([
        "<core-dependency-content>".to_string(),
        core_dependency_content_sha256,
    ]);

    let core_archive = capture_file_evidence_from_canonical(
        input.core_archive,
        std::slice::from_ref(&build_root),
        MAX_CORE_ARCHIVE_BYTES,
        "Core archive",
        &mut file_cache,
    )?;
    if first_relative_component(input.core_archive, input.build_dir).as_deref() != Some("core") {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::PathEscape,
            "Core archive is not below build/core",
        ));
    }

    if input.ordered_link_inputs.is_empty() || input.ordered_link_inputs.len() > MAX_LINK_INPUTS {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::BoundExceeded,
            "ordered link-input count is outside the bounded contract",
        ));
    }
    let expected_inputs = std::iter::once(sketch.object.path.clone())
        .chain(library_units.iter().map(|unit| unit.object.path.clone()))
        .collect::<BTreeSet<_>>();
    let mut observed_inputs = BTreeSet::<String>::new();
    let mut ordered_link_inputs = Vec::<String>::new();
    for path in input.ordered_link_inputs {
        let (canonical, _) = file_cache.capture(
            path,
            std::slice::from_ref(&build_root),
            MAX_OBJECT_BYTES,
            false,
            "ordered link object",
        )?;
        if canonical
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("o"))
        {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::InvalidInput,
                "ordered link input is not an object file",
            ));
        }
        let key = normalized_path(&canonical);
        if !observed_inputs.insert(key.clone()) {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::AmbiguousGraph,
                "ordered link inputs contain a duplicate object",
            ));
        }
        ordered_link_inputs.push(key);
    }
    if observed_inputs != expected_inputs {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::AmbiguousGraph,
            "ordered link inputs do not exactly cover sketch plus library objects",
        ));
    }
    let ordered_link_inputs_sha256 = hash_framed(
        b"ck-esp32-library-link-order-v1",
        ordered_link_inputs.iter().map(String::as_str),
    );
    let command_graph_sha256 = hash_framed(
        b"ck-esp32-library-command-graph-v1",
        graph_parts.iter().map(String::as_str),
    );
    let native_link = capture_native_link_command(
        input.link_argv,
        input.link_working_directory,
        &build_root,
        input.project_name,
        input.core_archive,
        input.ordered_link_inputs,
        &tool_roots,
        &working_roots,
        &link_response_roots,
        &mut file_cache,
    )?;
    let manifest = Esp32LibraryRelinkManifest {
        schema_version: ESP32_LIBRARY_RELINK_MANIFEST_SCHEMA_VERSION,
        evidence_contract: ESP32_LIBRARY_RELINK_EVIDENCE_CONTRACT.into(),
        canonical_fqbn: input.canonical_fqbn.into(),
        build_signature: input.build_signature.into(),
        toolchain_key: input.toolchain_key.into(),
        property_contract_sha256: input.property_contract_sha256.into(),
        canonical_build_dir: normalized_path(&build_root),
        project_name: input.project_name.into(),
        ccdb,
        command_graph_sha256,
        library_roots: library_root_evidence,
        sketch,
        library_units,
        core_archive,
        native_link,
        ordered_link_inputs,
        ordered_link_inputs_sha256,
    };
    file_cache.revalidate_reused()?;
    manifest.validate_header()?;
    Ok(CapturedEsp32LibraryRelinkManifest {
        manifest,
        file_cache,
        core_dependencies,
        dependency_roots,
    })
}

pub(super) fn capture_esp32_library_relink_manifest(
    input: Esp32LibraryRelinkCaptureInput<'_>,
) -> GateResult<Esp32LibraryRelinkManifest> {
    capture_esp32_library_relink_manifest_with_receipt(input).map(|captured| captured.manifest)
}

pub(super) fn validate_esp32_library_relink_manifest(
    expected: &Esp32LibraryRelinkManifest,
    input: Esp32LibraryRelinkCaptureInput<'_>,
) -> GateResult<ValidatedEsp32LibraryGraph> {
    expected.validate_header()?;
    let current = capture_esp32_library_relink_manifest(input)?;
    if &current != expected {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::EvidenceMismatch,
            "current ESP32 library graph differs from the sealed native baseline",
        ));
    }
    Ok(ValidatedEsp32LibraryGraph {
        sketch_object: PathBuf::from(&current.sketch.object.path),
        library_objects: current
            .library_units
            .iter()
            .map(|unit| PathBuf::from(&unit.object.path))
            .collect(),
        ordered_link_inputs: current
            .ordered_link_inputs
            .iter()
            .map(PathBuf::from)
            .collect(),
        core_archive: PathBuf::from(&current.core_archive.path),
        native_link: ValidatedEsp32NativeLinkCommand {
            working_directory: PathBuf::from(&current.native_link.working_directory),
            executable: PathBuf::from(&current.native_link.executable.path),
            argv: current.native_link.argv.clone(),
        },
    })
}

pub(super) fn revalidate_esp32_native_link_command(
    expected: &Esp32NativeLinkCommandEvidence,
    build_dir: &Path,
    project_name: &str,
    core_archive: &Path,
    ordered_link_inputs: &[PathBuf],
    tool_roots: &[PathBuf],
    working_roots: &[PathBuf],
    response_roots: &[PathBuf],
) -> GateResult<ValidatedEsp32NativeLinkCommand> {
    expected.validate_header()?;
    let build_root = canonical_directory(build_dir, "ESP32 build directory")?;
    let tool_roots = canonical_roots(tool_roots, "tool root", 32)?;
    let working_roots = canonical_roots(working_roots, "working root", 32)?;
    let response_roots = canonical_roots(response_roots, "native link response root", 32)?;
    let mut file_cache = CaptureFileEvidenceCache::default();
    let current = capture_native_link_command(
        &expected.argv,
        Path::new(&expected.working_directory),
        &build_root,
        project_name,
        core_archive,
        ordered_link_inputs,
        &tool_roots,
        &working_roots,
        &response_roots,
        &mut file_cache,
    )?;
    file_cache.revalidate_reused()?;
    if &current != expected {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::EvidenceMismatch,
            "native link command or response graph differs from the sealed baseline",
        ));
    }
    Ok(ValidatedEsp32NativeLinkCommand {
        working_directory: PathBuf::from(&current.working_directory),
        executable: PathBuf::from(&current.executable.path),
        argv: current.argv,
    })
}

fn validate_refreshed_esp32_library_relink_manifest(
    expected: &Esp32LibraryRelinkManifest,
    current: &Esp32LibraryRelinkManifest,
) -> GateResult<ValidatedEsp32NativeLinkCommand> {
    let mut comparable = current.clone();
    comparable.sketch.source.size = expected.sketch.source.size;
    comparable.sketch.source.sha256 = expected.sketch.source.sha256.clone();
    comparable.sketch.object.size = expected.sketch.object.size;
    comparable.sketch.object.sha256 = expected.sketch.object.sha256.clone();
    let expected_sketch_source_path = normalized_path(Path::new(&expected.sketch.source.path));
    let current_sketch_source_path = normalized_path(Path::new(&current.sketch.source.path));
    if expected_sketch_source_path != current_sketch_source_path {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::EvidenceMismatch,
            "sketch source path changed during ESP32 library replay",
        ));
    }
    let expected_source_dependencies = expected
        .sketch
        .dependencies
        .iter()
        .filter(|dependency| {
            normalized_path(Path::new(&dependency.path)) == expected_sketch_source_path
        })
        .collect::<Vec<_>>();
    let current_source_dependency_indexes = comparable
        .sketch
        .dependencies
        .iter()
        .enumerate()
        .filter_map(|(index, dependency)| {
            (normalized_path(Path::new(&dependency.path)) == current_sketch_source_path)
                .then_some(index)
        })
        .collect::<Vec<_>>();
    if expected_source_dependencies.len() != 1 || current_source_dependency_indexes.len() != 1 {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::EvidenceMismatch,
            "sketch depfile does not bind exactly one generated sketch source",
        ));
    }
    comparable.sketch.dependencies[current_source_dependency_indexes[0]] =
        expected_source_dependencies[0].clone();
    if comparable != *expected {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::EvidenceMismatch,
            "immutable ESP32 library/Core/link evidence changed during sketch replay",
        ));
    }
    // `capture_esp32_library_relink_manifest` already captures and hashes the
    // complete native link command, executable, response graph, outputs, and
    // object order. The immutable comparison above therefore authenticates the
    // exact same fields that `revalidate_esp32_native_link_command` would
    // recapture. Reuse that authenticated value instead of reading the whole
    // linker graph a second time on every refresh.
    let native_link = ValidatedEsp32NativeLinkCommand {
        working_directory: PathBuf::from(&current.native_link.working_directory),
        executable: PathBuf::from(&current.native_link.executable.path),
        argv: current.native_link.argv.clone(),
    };
    Ok(native_link)
}

/// Re-capture a library baseline after the generated sketch source and object
/// have intentionally changed. Every other byte-bound identity, including the
/// sketch depfile, must still match the sealed native baseline. The returned
/// one-request seal retains the complete evidence needed to verify that graph
/// again after linking without parsing the CCDB a third time.
pub(super) fn refresh_esp32_library_relink_manifest_with_final_seal(
    expected: &Esp32LibraryRelinkManifest,
    input: Esp32LibraryRelinkCaptureInput<'_>,
) -> GateResult<Esp32LibraryRelinkRefreshSeal> {
    expected.validate_header()?;
    let captured = capture_esp32_library_relink_manifest_with_receipt(input)?;
    captured.file_cache.require_complete()?;
    let native_link =
        validate_refreshed_esp32_library_relink_manifest(expected, &captured.manifest)?;
    Ok(Esp32LibraryRelinkRefreshSeal {
        captured,
        native_link,
    })
}

pub(super) fn refresh_esp32_library_relink_manifest(
    expected: &Esp32LibraryRelinkManifest,
    input: Esp32LibraryRelinkCaptureInput<'_>,
) -> GateResult<(Esp32LibraryRelinkManifest, ValidatedEsp32NativeLinkCommand)> {
    let seal = refresh_esp32_library_relink_manifest_with_final_seal(expected, input)?;
    Ok((seal.captured.manifest, seal.native_link))
}

fn revalidate_final_library_roots(expected_roots: &[Esp32LibraryRootEvidence]) -> GateResult<()> {
    for expected in expected_roots {
        let canonical =
            canonical_directory(Path::new(&expected.path), "final refresh seal library root")?;
        if normalized_path(&canonical) != expected.path {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::EvidenceMismatch,
                "library root identity changed after the complete pre-link refresh",
            ));
        }
        reject_unsupported_library_semantics(&canonical)?;
        let current = capture_library_root_evidence(&canonical)?;
        if &current != expected {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::EvidenceMismatch,
                format!(
                    "library tree changed after the complete pre-link refresh: {}",
                    canonical.display()
                ),
            ));
        }
    }
    Ok(())
}

fn revalidate_final_native_link_paths(manifest: &Esp32LibraryRelinkManifest) -> GateResult<()> {
    let build_root = canonical_directory(
        Path::new(&manifest.canonical_build_dir),
        "final refresh seal build directory",
    )?;
    if normalized_path(&build_root) != manifest.canonical_build_dir {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::EvidenceMismatch,
            "build directory identity changed after the complete pre-link refresh",
        ));
    }
    let working = canonical_directory(
        Path::new(&manifest.native_link.working_directory),
        "final refresh seal link working directory",
    )?;
    if normalized_path(&working) != manifest.native_link.working_directory {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::EvidenceMismatch,
            "native link working-directory identity changed after the complete pre-link refresh",
        ));
    }
    for (raw, label) in [
        (
            manifest.native_link.elf_output.as_str(),
            "final ESP32 ELF output",
        ),
        (
            manifest.native_link.map_output.as_str(),
            "final ESP32 MAP output",
        ),
    ] {
        let (canonical, _) = validated_canonical_file(
            Path::new(raw),
            std::slice::from_ref(&build_root),
            u64::MAX,
            false,
            label,
        )?;
        if normalized_path(&canonical) != raw {
            return Err(Esp32LibraryRelinkGateError::new(
                Esp32LibraryRelinkGateCode::EvidenceMismatch,
                format!("{label} identity changed after the native link"),
            ));
        }
    }
    Ok(())
}

/// Consume the pre-link seal only after the native linker and artifact recipes
/// complete. Every file captured before the link is hashed again, every path is
/// checked for reparse/identity changes, complete library trees are re-sealed,
/// and Core depfiles plus their deduplicated dependency paths are revalidated.
/// Only then may the post-edit manifest be committed as the next baseline.
pub(super) fn finalize_esp32_library_relink_refresh_seal(
    seal: Esp32LibraryRelinkRefreshSeal,
) -> GateResult<Esp32LibraryRelinkManifest> {
    let CapturedEsp32LibraryRelinkManifest {
        manifest,
        file_cache,
        core_dependencies,
        dependency_roots,
    } = seal.captured;
    manifest.validate_header()?;
    revalidate_final_library_roots(&manifest.library_roots)?;
    revalidate_final_native_link_paths(&manifest)?;
    core_dependencies.revalidate_final(&dependency_roots)?;
    // Keep the complete byte-for-byte pass last so actual link inputs have the
    // narrowest practical validation-to-commit window.
    file_cache.revalidate_all()?;
    Ok(manifest)
}

pub(super) fn encode_esp32_library_relink_manifest(
    manifest: &Esp32LibraryRelinkManifest,
) -> GateResult<Vec<u8>> {
    manifest.validate_header()?;
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|error| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::InvalidInput,
            format!("cannot encode ESP32 library manifest: {error}"),
        )
    })?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::BoundExceeded,
            "ESP32 library manifest exceeds its byte bound",
        ));
    }
    Ok(bytes)
}

pub(super) fn decode_esp32_library_relink_manifest(
    bytes: &[u8],
) -> GateResult<Esp32LibraryRelinkManifest> {
    if bytes.is_empty() || bytes.len() > MAX_MANIFEST_BYTES {
        return Err(Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::BoundExceeded,
            "ESP32 library manifest byte length is outside the bounded contract",
        ));
    }
    let manifest: Esp32LibraryRelinkManifest = serde_json::from_slice(bytes).map_err(|error| {
        Esp32LibraryRelinkGateError::new(
            Esp32LibraryRelinkGateCode::InvalidInput,
            format!("ESP32 library manifest JSON is invalid: {error}"),
        )
    })?;
    manifest.validate_header()?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_PROPERTY_CONTRACT_SHA256: &str =
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const OTHER_PROPERTY_CONTRACT_SHA256: &str =
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    struct Fixture {
        _root: tempfile::TempDir,
        build: PathBuf,
        ccdb: PathBuf,
        core_archive: PathBuf,
        library: PathBuf,
        tool_root: PathBuf,
        dependency_root: PathBuf,
        working_root: PathBuf,
        link_working_directory: PathBuf,
        link_argv: Vec<String>,
        sketch_object: PathBuf,
        library_object: PathBuf,
        response: PathBuf,
        library_source: PathBuf,
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture parent");
        }
        std::fs::write(path, bytes).expect("fixture file");
    }

    #[test]
    fn request_local_file_cache_rehashes_reused_content_before_commit() {
        let root = tempfile::tempdir().expect("tempdir");
        let path = root.path().join("shared-header.h");
        write_file(&path, b"first");
        let roots = vec![std::fs::canonicalize(root.path()).expect("canonical root")];
        let mut cache = CaptureFileEvidenceCache::default();
        cache
            .capture(&path, &roots, 64, false, "shared header")
            .expect("initial capture");
        cache
            .capture(&path, &roots, 64, false, "shared header")
            .expect("request-local reuse");

        write_file(&path, b"other");
        let error = cache
            .revalidate_reused()
            .expect_err("same-size content mutation must invalidate reused evidence");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
    }

    #[test]
    fn request_local_file_cache_rechecks_each_call_constraint() {
        let root = tempfile::tempdir().expect("tempdir");
        let other = tempfile::tempdir().expect("other tempdir");
        let path = root.path().join("input.txt");
        write_file(&path, b"content");
        let roots = vec![std::fs::canonicalize(root.path()).expect("canonical root")];
        let other_root = std::fs::canonicalize(other.path()).expect("canonical other root");
        let mut cache = CaptureFileEvidenceCache::default();
        cache
            .capture(&path, &roots, 64, false, "input")
            .expect("initial capture");

        let error = cache
            .capture(&path, &[other_root], 64, false, "input")
            .expect_err("cache hit must not bypass the active root boundary");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::PathEscape);
        let error = cache
            .capture(&path, &roots, 3, false, "input")
            .expect_err("cache hit must not bypass the active size bound");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::BoundExceeded);

        let empty = root.path().join("empty.txt");
        write_file(&empty, b"");
        cache
            .capture(&empty, &roots, 64, true, "empty input")
            .expect("empty input admitted by its first caller");
        let error = cache
            .capture(&empty, &roots, 64, false, "empty input")
            .expect_err("cache hit must not bypass a non-empty requirement");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::BoundExceeded);
    }

    #[test]
    fn core_dependency_structure_deduplicates_references_but_keeps_validation() {
        let root = tempfile::tempdir().expect("tempdir");
        let dependency = root.path().join("sdk/shared.h");
        let object = root.path().join("build/core/unit.cpp.o");
        let depfile = object.with_extension("d");
        write_file(&dependency, b"#pragma once\n");
        write_file(&object, b"object");
        write_file(
            &depfile,
            format!("{}: {}\n", object.display(), dependency.display()).as_bytes(),
        );
        let roots = vec![std::fs::canonicalize(root.path()).expect("canonical root")];
        let mut proof = CoreDependencyStructureProof::default();
        proof
            .record_depfile(&depfile, root.path(), &roots)
            .expect("first depfile parse");
        proof
            .record_depfile(&depfile, root.path(), &roots)
            .expect("duplicate depfile parse");
        assert_eq!(proof.reference_count, 2);
        assert_eq!(proof.paths.len(), 1);
        proof
            .validate_unique_dependencies(&roots)
            .expect("unique dependency validation");

        std::fs::remove_file(&dependency).expect("remove dependency");
        let error = proof
            .validate_unique_dependencies(&roots)
            .expect_err("deduplication must not suppress the actual file gate");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::MissingEvidence);
    }

    fn entry(
        compiler: &Path,
        working: &Path,
        response: &Path,
        source: &Path,
        object: &Path,
    ) -> CcdbEntry {
        CcdbEntry {
            directory: working.to_string_lossy().into_owned(),
            arguments: vec![
                compiler.to_string_lossy().into_owned(),
                format!("@{}", response.to_string_lossy()),
                "-c".into(),
                source.to_string_lossy().into_owned(),
                "-o".into(),
                object.to_string_lossy().into_owned(),
            ],
            command: String::new(),
            file: source.to_string_lossy().into_owned(),
            output: Some(object.to_string_lossy().into_owned()),
        }
    }

    fn make_fixture() -> Fixture {
        let root = tempfile::tempdir().expect("tempdir");
        let build = root.path().join("build");
        let library = root.path().join("libraries/Foo");
        let tool_root = root.path().join("tools");
        let dependency_root = root.path().join("platform");
        let working_root = root.path().join("working");
        for directory in [
            &build,
            &library,
            &tool_root,
            &dependency_root,
            &working_root,
        ] {
            std::fs::create_dir_all(directory).expect("fixture directory");
        }
        write_file(
            &library.join("library.properties"),
            b"name=Foo\nversion=1.0.0\narchitectures=esp32\n",
        );
        let compiler = tool_root.join("bin/esp32-g++.exe");
        let response = build.join("build_opt.h");
        write_file(&compiler, b"compiler evidence");
        write_file(&response, b"-DCK_FIXTURE=1");

        let sketch_source = build.join("sketch/demo.ino.cpp");
        let sketch_object = build.join("sketch/demo.ino.cpp.o");
        let core_source = dependency_root.join("cores/esp32/core.cpp");
        let core_object = build.join("core/core.cpp.o");
        let library_source = library.join("src/Foo.cpp");
        let library_header = library.join("src/Foo.h");
        let library_object = build.join("libraries/Foo/Foo.cpp.o");
        for (path, bytes) in [
            (&sketch_source, b"void setup(){} void loop(){}".as_slice()),
            (&sketch_object, b"sketch object".as_slice()),
            (&core_source, b"void core(){}".as_slice()),
            (&core_object, b"core object".as_slice()),
            (&library_source, b"int foo(){return 1;}".as_slice()),
            (&library_header, b"int foo();".as_slice()),
            (&library_object, b"library object".as_slice()),
        ] {
            write_file(path, bytes);
        }
        for (object, dependencies) in [
            (&sketch_object, vec![&sketch_source]),
            (&core_object, vec![&core_source]),
            (
                &library_object,
                vec![&library_source, &library_header, &core_source],
            ),
        ] {
            let depfile = object.with_extension("d");
            let line = format!(
                "{}: {}\n",
                object.display(),
                dependencies
                    .iter()
                    .map(|path| path.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            write_file(&depfile, line.as_bytes());
        }
        let core_archive = build.join("core/core.a");
        write_file(&core_archive, b"core archive");
        let link_elf = build.join("demo.elf");
        let link_map = build.join("demo.map");
        write_file(&link_elf, b"link elf");
        write_file(&link_map, b"link map");
        let link_argv = vec![
            compiler.to_string_lossy().into_owned(),
            format!("-Wl,--Map={}", link_map.display()),
            "-Wl,--start-group".into(),
            sketch_object.to_string_lossy().into_owned(),
            library_object.to_string_lossy().into_owned(),
            core_archive.to_string_lossy().into_owned(),
            format!("@{}", response.display()),
            "-Wl,--end-group".into(),
            "-o".into(),
            link_elf.to_string_lossy().into_owned(),
        ];
        let ccdb = build.join("compile_commands.json");
        let entries = vec![
            entry(
                &compiler,
                &working_root,
                &response,
                &sketch_source,
                &sketch_object,
            ),
            entry(
                &compiler,
                &working_root,
                &response,
                &core_source,
                &core_object,
            ),
            entry(
                &compiler,
                &working_root,
                &response,
                &library_source,
                &library_object,
            ),
        ];
        write_file(
            &ccdb,
            &serde_json::to_vec_pretty(&entries).expect("CCDB JSON"),
        );
        Fixture {
            _root: root,
            build,
            ccdb,
            core_archive,
            library,
            tool_root,
            dependency_root,
            working_root: working_root.clone(),
            link_working_directory: working_root,
            link_argv,
            sketch_object,
            library_object,
            response,
            library_source,
        }
    }

    fn capture_input<'a>(
        fixture: &'a Fixture,
        library_roots: &'a [PathBuf],
        tool_roots: &'a [PathBuf],
        working_roots: &'a [PathBuf],
        dependency_roots: &'a [PathBuf],
        link_inputs: &'a [PathBuf],
    ) -> Esp32LibraryRelinkCaptureInput<'a> {
        Esp32LibraryRelinkCaptureInput {
            canonical_fqbn: "esp32:esp32:esp32c6",
            build_signature: "build-signature",
            toolchain_key: "toolchain-key",
            property_contract_sha256: TEST_PROPERTY_CONTRACT_SHA256,
            build_dir: &fixture.build,
            project_name: "demo",
            ccdb_path: &fixture.ccdb,
            core_archive: &fixture.core_archive,
            allowed_library_roots: library_roots,
            allowed_tool_roots: tool_roots,
            allowed_working_roots: working_roots,
            allowed_dependency_roots: dependency_roots,
            allowed_link_response_roots: dependency_roots,
            link_working_directory: &fixture.link_working_directory,
            link_argv: &fixture.link_argv,
            ordered_link_inputs: link_inputs,
        }
    }

    #[test]
    fn capture_round_trip_binds_library_graph_and_native_link_order() {
        let fixture = make_fixture();
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let manifest = capture_esp32_library_relink_manifest(input).expect("capture manifest");
        assert_eq!(manifest.library_units.len(), 1);
        assert_eq!(manifest.library_roots.len(), 1);
        assert_eq!(manifest.library_roots[0].file_count, 3);
        assert!(manifest.library_roots[0].total_bytes > 0);
        assert!(is_sha256(&manifest.library_roots[0].tree_sha256));
        assert_eq!(
            manifest.property_contract_sha256,
            TEST_PROPERTY_CONTRACT_SHA256
        );
        assert_eq!(manifest.ordered_link_inputs.len(), 2);
        let bytes = encode_esp32_library_relink_manifest(&manifest).expect("encode manifest");
        let decoded = decode_esp32_library_relink_manifest(&bytes).expect("decode manifest");
        assert_eq!(decoded, manifest);
        let validated =
            validate_esp32_library_relink_manifest(&manifest, input).expect("validate manifest");
        assert_eq!(validated.ordered_link_inputs.len(), 2);
        assert_eq!(validated.library_objects.len(), 1);
    }

    #[test]
    fn real_c6_verbose_link_flows_from_stream_capture_to_sealed_manifest() {
        let mut fixture = make_fixture();
        let flags_root = fixture.tool_root.join("esp32c6-libs/3.3.6/flags");
        let ld_flags = flags_root.join("ld_flags");
        let ld_scripts = flags_root.join("ld_scripts");
        let ld_libs = flags_root.join("ld_libs");
        write_file(&ld_flags, b"-Wl,--gc-sections\n");
        write_file(&ld_scripts, b"-T esp32c6.peripherals.ld\n");
        write_file(&ld_libs, b"-lm -lc -lgcc\n");

        let link_map = fixture.build.join("demo.map");
        let link_elf = fixture.build.join("demo.elf");
        fixture.link_argv = vec![
            fixture.link_argv[0].clone(),
            format!("-Wl,--Map={}", link_map.display()),
            format!(
                "-L{}",
                fixture.tool_root.join("esp32c6-libs/3.3.6/lib").display()
            ),
            format!(
                "-L{}",
                fixture.tool_root.join("esp32c6-libs/3.3.6/ld").display()
            ),
            "-Wl,--wrap=esp_panic_handler".into(),
            format!("@{}", ld_flags.display()),
            format!("@{}", ld_scripts.display()),
            "-Wl,--start-group".into(),
            fixture.sketch_object.to_string_lossy().into_owned(),
            fixture.library_object.to_string_lossy().into_owned(),
            fixture.core_archive.to_string_lossy().into_owned(),
            format!("@{}", ld_libs.display()),
            "-Wl,--end-group".into(),
            "-Wl,-EL".into(),
            "-o".into(),
            link_elf.to_string_lossy().into_owned(),
        ];
        let verbose_line = fixture
            .link_argv
            .iter()
            .map(|token| {
                if token == "-o" || token.starts_with("-Wl,") {
                    token.clone()
                } else {
                    format!("\"{token}\"")
                }
            })
            .collect::<Vec<_>>()
            .join(" ");

        let first = verbose_line.len() / 3;
        let second = first * 2;
        let mut stream = super::super::Esp32NativeLinkLineCapture::default();
        stream.observe(&verbose_line[..first], false, false);
        stream.observe(&verbose_line[first..second], false, false);
        stream.observe(&verbose_line[second..], true, false);
        let captured = stream
            .finish(
                &fixture.build,
                &fixture.core_archive,
                &fixture.link_working_directory,
            )
            .expect("real C6-shaped verbose link command");
        fixture.link_working_directory = captured.working_directory;
        fixture.link_argv = captured.argv;
        let link_inputs = captured.ordered_link_inputs;

        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![
            fixture.build.clone(),
            fixture.dependency_root.clone(),
            fixture.tool_root.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let manifest = capture_esp32_library_relink_manifest(input)
            .expect("C6-shaped command must produce a sealed manifest");
        assert_eq!(manifest.native_link.argv, fixture.link_argv);
        assert_eq!(manifest.native_link.response_files.len(), 3);
        assert!(
            manifest.native_link.response_files[0]
                .file
                .path
                .ends_with("/ld_flags")
        );
        assert!(
            manifest.native_link.response_files[1]
                .file
                .path
                .ends_with("/ld_scripts")
        );
        assert!(
            manifest.native_link.response_files[2]
                .file
                .path
                .ends_with("/ld_libs")
        );

        let validated = validate_esp32_library_relink_manifest(&manifest, input)
            .expect("sealed C6-shaped manifest must revalidate");
        assert_eq!(validated.native_link.argv, fixture.link_argv);
        assert_eq!(
            validated
                .ordered_link_inputs
                .iter()
                .map(|path| normalized_path(path))
                .collect::<Vec<_>>(),
            link_inputs
                .iter()
                .map(|path| normalized_path(path))
                .collect::<Vec<_>>()
        );
    }

    #[cfg(windows)]
    #[test]
    fn capture_accepts_only_the_same_absolute_compiler_with_exe_suffix() {
        let fixture = make_fixture();
        let mut entries: Vec<CcdbEntry> =
            serde_json::from_slice(&std::fs::read(&fixture.ccdb).expect("fixture CCDB bytes"))
                .expect("fixture CCDB JSON");
        for entry in &mut entries {
            let compiler = PathBuf::from(&entry.arguments[0]);
            assert_eq!(
                compiler.extension().and_then(|value| value.to_str()),
                Some("exe")
            );
            entry.arguments[0] = compiler.with_extension("").to_string_lossy().into_owned();
        }
        write_file(
            &fixture.ccdb,
            &serde_json::to_vec_pretty(&entries).expect("suffixless CCDB JSON"),
        );

        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        capture_esp32_library_relink_manifest(capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        ))
        .expect("same absolute Windows compiler with .exe suffix");
    }

    #[test]
    fn validation_rejects_response_or_source_content_change() {
        let fixture = make_fixture();
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let manifest = capture_esp32_library_relink_manifest(input).expect("capture manifest");

        write_file(&fixture.response, b"-DCK_FIXTURE=2");
        let error = validate_esp32_library_relink_manifest(&manifest, input)
            .expect_err("response mutation must fail");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);

        write_file(&fixture.response, b"-DCK_FIXTURE=1");
        write_file(&fixture.library_source, b"int foo(){return 2;}");
        let error = validate_esp32_library_relink_manifest(&manifest, input)
            .expect_err("source mutation must fail");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
    }

    #[test]
    fn validation_rejects_unreferenced_library_tree_change() {
        let fixture = make_fixture();
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let manifest = capture_esp32_library_relink_manifest(input).expect("capture manifest");

        write_file(
            &fixture.library.join("examples/unreferenced.txt"),
            b"not present in any depfile",
        );
        let error = validate_esp32_library_relink_manifest(&manifest, input)
            .expect_err("an unreferenced library file must invalidate the complete tree proof");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
    }

    #[test]
    fn validation_rejects_sketch_project_header_content_change() {
        let fixture = make_fixture();
        let sketch_source = fixture.build.join("sketch/demo.ino.cpp");
        let project_header = fixture.dependency_root.join("project/config.h");
        write_file(&project_header, b"#define CK_VALUE 1\n");
        write_file(
            &fixture.sketch_object.with_extension("d"),
            format!(
                "{}: {} {}\n",
                fixture.sketch_object.display(),
                sketch_source.display(),
                project_header.display()
            )
            .as_bytes(),
        );
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let manifest = capture_esp32_library_relink_manifest(input).expect("capture manifest");

        write_file(&project_header, b"#define CK_VALUE 2\n");
        let error = validate_esp32_library_relink_manifest(&manifest, input)
            .expect_err("a project header used by the sketch must remain content sealed");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
    }

    #[test]
    fn validation_rejects_release_property_contract_change() {
        let fixture = make_fixture();
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let baseline = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let manifest = capture_esp32_library_relink_manifest(baseline).expect("capture manifest");
        let mut current = baseline;
        current.property_contract_sha256 = OTHER_PROPERTY_CONTRACT_SHA256;

        let error = validate_esp32_library_relink_manifest(&manifest, current)
            .expect_err("a different Release property contract must fail closed");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
    }

    #[test]
    fn validation_rejects_reordered_native_link_inputs() {
        let fixture = make_fixture();
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let baseline = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let manifest = capture_esp32_library_relink_manifest(baseline).expect("capture manifest");
        let reordered = vec![
            fixture.library_object.clone(),
            fixture.sketch_object.clone(),
        ];
        let current = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &reordered,
        );
        let error = validate_esp32_library_relink_manifest(&manifest, current)
            .expect_err("link order mutation must fail");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::AmbiguousGraph);
    }

    #[test]
    fn validation_rejects_link_argv_executable_and_response_identity_changes() {
        let mut fixture = make_fixture();
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let manifest = capture_esp32_library_relink_manifest(capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        ))
        .expect("capture manifest");

        let group_index = fixture
            .link_argv
            .iter()
            .position(|token| token == "-Wl,--start-group")
            .expect("group token");
        fixture
            .link_argv
            .insert(group_index, "-Wl,--gc-sections".into());
        let error = validate_esp32_library_relink_manifest(
            &manifest,
            capture_input(
                &fixture,
                &libraries,
                &tools,
                &working,
                &dependencies,
                &link_inputs,
            ),
        )
        .expect_err("an otherwise valid argv insertion must invalidate the seal");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
        fixture.link_argv.remove(group_index);

        let original_executable = fixture.link_argv[0].clone();
        let alternate_executable = fixture.tool_root.join("bin/alternate-g++.exe");
        write_file(&alternate_executable, b"compiler evidence");
        fixture.link_argv[0] = alternate_executable.to_string_lossy().into_owned();
        let error = validate_esp32_library_relink_manifest(
            &manifest,
            capture_input(
                &fixture,
                &libraries,
                &tools,
                &working,
                &dependencies,
                &link_inputs,
            ),
        )
        .expect_err("a same-content executable at another path must invalidate the seal");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
        fixture.link_argv[0] = original_executable;

        let response_index = fixture
            .link_argv
            .iter()
            .position(|token| token.starts_with('@'))
            .expect("response token");
        let original_response = fixture.link_argv[response_index].clone();
        let alternate_response = fixture.build.join("alternate-link.rsp");
        write_file(&alternate_response, b"-DCK_FIXTURE=1");
        fixture.link_argv[response_index] = format!("@{}", alternate_response.display());
        let error = validate_esp32_library_relink_manifest(
            &manifest,
            capture_input(
                &fixture,
                &libraries,
                &tools,
                &working,
                &dependencies,
                &link_inputs,
            ),
        )
        .expect_err("a same-content response at another path must invalidate the seal");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
        fixture.link_argv[response_index] = original_response;

        fixture.link_argv.remove(response_index);
        let error = validate_esp32_library_relink_manifest(
            &manifest,
            capture_input(
                &fixture,
                &libraries,
                &tools,
                &working,
                &dependencies,
                &link_inputs,
            ),
        )
        .expect_err("removing a response file must invalidate the seal");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
    }

    #[test]
    fn validation_rejects_response_reordering() {
        let mut fixture = make_fixture();
        let second_response = fixture.build.join("second-link.rsp");
        write_file(&second_response, b"-Wl,--gc-sections\n");
        let group_index = fixture
            .link_argv
            .iter()
            .position(|token| token == "-Wl,--start-group")
            .expect("group token");
        fixture
            .link_argv
            .insert(group_index, format!("@{}", second_response.display()));
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let manifest = capture_esp32_library_relink_manifest(capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        ))
        .expect("capture two-response manifest");
        let response_indices = fixture
            .link_argv
            .iter()
            .enumerate()
            .filter_map(|(index, token)| token.starts_with('@').then_some(index))
            .collect::<Vec<_>>();
        assert_eq!(response_indices.len(), 2);
        fixture
            .link_argv
            .swap(response_indices[0], response_indices[1]);
        let error = validate_esp32_library_relink_manifest(
            &manifest,
            capture_input(
                &fixture,
                &libraries,
                &tools,
                &working,
                &dependencies,
                &link_inputs,
            ),
        )
        .expect_err("response-file order must be part of the seal");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
    }

    #[test]
    fn response_graph_supports_nested_crlf_and_detects_nested_mutation() {
        let mut fixture = make_fixture();
        let top = fixture.build.join("link-top.rsp");
        let nested = fixture.build.join("link-nested.rsp");
        write_file(&nested, b"-Wl,--no-warn-rwx-segments\r\n");
        write_file(
            &top,
            format!("-Wl,--gc-sections\r\n@{}\r\n", nested.display()).as_bytes(),
        );
        let response_index = fixture
            .link_argv
            .iter()
            .position(|token| token.starts_with('@'))
            .expect("fixture response token");
        fixture.link_argv[response_index] = format!("@{}", top.display());
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let manifest = capture_esp32_library_relink_manifest(input).expect("nested response graph");
        assert_eq!(manifest.native_link.response_files.len(), 2);
        assert_eq!(manifest.native_link.response_files[0].depth, 0);
        assert_eq!(manifest.native_link.response_files[1].depth, 1);

        write_file(&nested, b"-Wl,--warn-rwx-segments\n");
        let error = validate_esp32_library_relink_manifest(&manifest, input)
            .expect_err("nested response mutation must fail");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
    }

    #[test]
    fn response_graph_rejects_cycles_hidden_outputs_and_indirect_tokens() {
        let mut fixture = make_fixture();
        let top = fixture.build.join("link-top.rsp");
        let nested = fixture.build.join("link-nested.rsp");
        write_file(&top, format!("@{}\n", nested.display()).as_bytes());
        write_file(&nested, format!("@{}\n", top.display()).as_bytes());
        let response_index = fixture
            .link_argv
            .iter()
            .position(|token| token.starts_with('@'))
            .expect("fixture response token");
        fixture.link_argv[response_index] = format!("@{}", top.display());
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let error = capture_esp32_library_relink_manifest(capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        ))
        .expect_err("response cycle must fail");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::AmbiguousGraph);

        write_file(&top, b"-o hidden.elf\n");
        let error = capture_esp32_library_relink_manifest(capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        ))
        .expect_err("hidden response output must fail");
        assert_eq!(
            error.code,
            Esp32LibraryRelinkGateCode::UnsupportedLibrarySemantics
        );

        fixture.link_argv[response_index] = format!("-Wl,@{}", top.display());
        let error = capture_esp32_library_relink_manifest(capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        ))
        .expect_err("unsealed indirect response token must fail");
        assert_eq!(
            error.code,
            Esp32LibraryRelinkGateCode::UnsupportedLibrarySemantics
        );
    }

    #[test]
    fn response_graph_rejects_missing_non_utf8_and_overdeep_files() {
        let mut fixture = make_fixture();
        let response_index = fixture
            .link_argv
            .iter()
            .position(|token| token.starts_with('@'))
            .expect("fixture response token");
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];

        fixture.link_argv[response_index] =
            format!("@{}", fixture.build.join("missing.rsp").display());
        let error = capture_esp32_library_relink_manifest(capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        ))
        .expect_err("a missing response file must fail closed");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::MissingEvidence);

        let non_utf8 = fixture.build.join("non-utf8.rsp");
        write_file(&non_utf8, &[0xff, 0xfe, 0xfd]);
        fixture.link_argv[response_index] = format!("@{}", non_utf8.display());
        let error = capture_esp32_library_relink_manifest(capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        ))
        .expect_err("a non-UTF-8 response file must fail closed");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::InvalidInput);

        let chain = (0..=MAX_RESPONSE_DEPTH + 1)
            .map(|index| fixture.build.join(format!("depth-{index}.rsp")))
            .collect::<Vec<_>>();
        for (index, path) in chain.iter().enumerate() {
            if let Some(next) = chain.get(index + 1) {
                write_file(path, format!("@{}\n", next.display()).as_bytes());
            } else {
                write_file(path, b"-Wl,--gc-sections\n");
            }
        }
        fixture.link_argv[response_index] = format!("@{}", chain[0].display());
        let error = capture_esp32_library_relink_manifest(capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        ))
        .expect_err("an over-deep response graph must fail closed");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::BoundExceeded);
    }

    #[test]
    fn native_link_rejects_extra_archive_and_project_output_rebinding() {
        let mut fixture = make_fixture();
        let extra_archive = fixture.build.join("libraries/Hidden/hidden.a");
        write_file(&extra_archive, b"hidden archive");
        let output_index = fixture
            .link_argv
            .iter()
            .position(|token| token == "-o")
            .expect("fixture output token");
        fixture
            .link_argv
            .insert(output_index, extra_archive.to_string_lossy().into_owned());
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let error = capture_esp32_library_relink_manifest(capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        ))
        .expect_err("extra direct archive must fail");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::AmbiguousGraph);

        fixture.link_argv.remove(output_index);
        let mut rebound = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        rebound.project_name = "other";
        let error = capture_esp32_library_relink_manifest(rebound)
            .expect_err("project/output rebinding must fail");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::AmbiguousGraph);
    }

    #[test]
    fn refresh_allows_only_sketch_source_and_object_bytes_to_change() {
        let fixture = make_fixture();
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let manifest = capture_esp32_library_relink_manifest(input).expect("capture manifest");
        write_file(
            Path::new(&manifest.sketch.source.path),
            b"void setup(){int x=1;} void loop(){}",
        );
        write_file(
            Path::new(&manifest.sketch.object.path),
            b"new sketch object",
        );
        refresh_esp32_library_relink_manifest(&manifest, input)
            .expect("only sketch source/object bytes may refresh");

        write_file(
            Path::new(&manifest.sketch.depfile.path),
            format!(
                "{}: {}  \n",
                manifest.sketch.object.path, manifest.sketch.source.path
            )
            .as_bytes(),
        );
        let error = refresh_esp32_library_relink_manifest(&manifest, input)
            .expect_err("sketch dependency topology must remain sealed");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
    }

    #[test]
    fn refresh_rejects_library_core_and_link_response_mutation() {
        for mutation in ["library-object", "core-archive", "link-response"] {
            let fixture = make_fixture();
            let libraries = vec![fixture.library.clone()];
            let tools = vec![fixture.tool_root.clone()];
            let working = vec![fixture.working_root.clone()];
            let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
            let link_inputs = vec![
                fixture.sketch_object.clone(),
                fixture.library_object.clone(),
            ];
            let input = capture_input(
                &fixture,
                &libraries,
                &tools,
                &working,
                &dependencies,
                &link_inputs,
            );
            let manifest = capture_esp32_library_relink_manifest(input).expect("capture manifest");
            match mutation {
                "library-object" => write_file(&fixture.library_object, b"changed library object"),
                "core-archive" => write_file(&fixture.core_archive, b"changed core archive"),
                "link-response" => write_file(&fixture.response, b"-DCK_FIXTURE=2"),
                _ => unreachable!(),
            }
            let error = refresh_esp32_library_relink_manifest(&manifest, input)
                .expect_err("immutable evidence mutation must fail before sealed link replay");
            assert_eq!(
                error.code,
                Esp32LibraryRelinkGateCode::EvidenceMismatch,
                "mutation: {mutation}"
            );
        }
    }

    #[test]
    fn final_seal_commits_the_verified_post_edit_manifest() {
        let fixture = make_fixture();
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let expected = capture_esp32_library_relink_manifest(input).expect("capture baseline");
        write_file(
            Path::new(&expected.sketch.source.path),
            b"void setup(){int refreshed=1;} void loop(){}",
        );
        write_file(
            Path::new(&expected.sketch.object.path),
            b"refreshed sketch object",
        );

        let seal = refresh_esp32_library_relink_manifest_with_final_seal(&expected, input)
            .expect("complete pre-link refresh");
        assert_eq!(seal.native_link().argv, expected.native_link.argv);
        let current = finalize_esp32_library_relink_refresh_seal(seal)
            .expect("unchanged post-link evidence must finalize");
        assert_ne!(current.sketch.source.sha256, expected.sketch.source.sha256);
        assert_ne!(current.sketch.object.sha256, expected.sketch.object.sha256);
        validate_esp32_library_relink_manifest(&current, input)
            .expect("final seal must return the exact next-request baseline");
    }

    #[test]
    fn final_seal_rejects_any_captured_file_mutation() {
        for mutation in [
            "sketch-source",
            "sketch-object",
            "library-object",
            "core-archive",
            "link-response",
            "linker",
            "ccdb",
        ] {
            let fixture = make_fixture();
            let libraries = vec![fixture.library.clone()];
            let tools = vec![fixture.tool_root.clone()];
            let working = vec![fixture.working_root.clone()];
            let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
            let link_inputs = vec![
                fixture.sketch_object.clone(),
                fixture.library_object.clone(),
            ];
            let input = capture_input(
                &fixture,
                &libraries,
                &tools,
                &working,
                &dependencies,
                &link_inputs,
            );
            let expected = capture_esp32_library_relink_manifest(input).expect("capture baseline");
            let seal = refresh_esp32_library_relink_manifest_with_final_seal(&expected, input)
                .expect("complete pre-link refresh");
            match mutation {
                "sketch-source" => write_file(
                    Path::new(&expected.sketch.source.path),
                    b"void setup(){int changed=1;} void loop(){}",
                ),
                "sketch-object" => write_file(&fixture.sketch_object, b"changed sketch object"),
                "library-object" => write_file(&fixture.library_object, b"changed library object"),
                "core-archive" => write_file(&fixture.core_archive, b"changed core archive"),
                "link-response" => write_file(&fixture.response, b"-DCK_FIXTURE=2"),
                "linker" => write_file(Path::new(&fixture.link_argv[0]), b"changed linker"),
                "ccdb" => write_file(&fixture.ccdb, b"[]"),
                _ => unreachable!(),
            }
            let error = finalize_esp32_library_relink_refresh_seal(seal)
                .expect_err("post-link captured-file mutation must fail closed");
            assert_eq!(
                error.code,
                Esp32LibraryRelinkGateCode::EvidenceMismatch,
                "mutation: {mutation}"
            );
        }
    }

    #[test]
    fn final_seal_rejects_unreferenced_library_tree_mutation() {
        let fixture = make_fixture();
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let expected = capture_esp32_library_relink_manifest(input).expect("capture baseline");
        let seal = refresh_esp32_library_relink_manifest_with_final_seal(&expected, input)
            .expect("complete pre-link refresh");
        write_file(
            &fixture.library.join("examples/added-after-link.txt"),
            b"unreferenced but part of the selected library tree",
        );

        let error = finalize_esp32_library_relink_refresh_seal(seal)
            .expect_err("complete library-tree mutation must fail closed");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
    }

    #[test]
    fn final_seal_rejects_core_depfile_or_unique_dependency_mutation() {
        for mutation in ["depfile", "dependency", "dependency-content"] {
            let fixture = make_fixture();
            let core_source = fixture.dependency_root.join("cores/esp32/core.cpp");
            let core_only = fixture.dependency_root.join("sdk/core-only.h");
            let core_object = fixture.build.join("core/core.cpp.o");
            let core_depfile = core_object.with_extension("d");
            write_file(&core_only, b"#define CK_CORE_ONLY 1\n");
            write_file(
                &core_depfile,
                format!(
                    "{}: {} {}\n",
                    core_object.display(),
                    core_source.display(),
                    core_only.display()
                )
                .as_bytes(),
            );
            let libraries = vec![fixture.library.clone()];
            let tools = vec![fixture.tool_root.clone()];
            let working = vec![fixture.working_root.clone()];
            let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
            let link_inputs = vec![
                fixture.sketch_object.clone(),
                fixture.library_object.clone(),
            ];
            let input = capture_input(
                &fixture,
                &libraries,
                &tools,
                &working,
                &dependencies,
                &link_inputs,
            );
            let expected = capture_esp32_library_relink_manifest(input).expect("capture baseline");
            let seal = refresh_esp32_library_relink_manifest_with_final_seal(&expected, input)
                .expect("complete pre-link refresh");
            match mutation {
                "depfile" => write_file(
                    &core_depfile,
                    format!(
                        "{}: {} {}  \n",
                        core_object.display(),
                        core_source.display(),
                        core_only.display()
                    )
                    .as_bytes(),
                ),
                "dependency" => {
                    std::fs::remove_file(&core_only).expect("remove Core-only dependency")
                }
                "dependency-content" => write_file(&core_only, b"#define CK_CORE_ONLY 2\n"),
                _ => unreachable!(),
            }
            let error = finalize_esp32_library_relink_refresh_seal(seal)
                .expect_err("Core depfile/dependency mutation must fail closed");
            assert!(
                matches!(
                    error.code,
                    Esp32LibraryRelinkGateCode::EvidenceMismatch
                        | Esp32LibraryRelinkGateCode::MissingEvidence
                ),
                "mutation: {mutation}, error: {error}"
            );
        }
    }

    #[test]
    fn validation_rejects_same_size_core_dependency_content_change() {
        let fixture = make_fixture();
        let core_source = fixture.dependency_root.join("cores/esp32/core.cpp");
        let core_only = fixture.dependency_root.join("sdk/core-content.h");
        let core_object = fixture.build.join("core/core.cpp.o");
        let core_depfile = core_object.with_extension("d");
        write_file(&core_only, b"#define CK_CORE_CONTENT 1\n");
        write_file(
            &core_depfile,
            format!(
                "{}: {} {}\n",
                core_object.display(),
                core_source.display(),
                core_only.display()
            )
            .as_bytes(),
        );
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let manifest = capture_esp32_library_relink_manifest(input).expect("capture baseline");
        write_file(&core_only, b"#define CK_CORE_CONTENT 2\n");

        let error = validate_esp32_library_relink_manifest(&manifest, input)
            .expect_err("same-size Core dependency replacement must invalidate the baseline");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
    }

    #[cfg(windows)]
    #[test]
    fn final_seal_rejects_core_dependency_reparse_replacement() {
        let fixture = make_fixture();
        let core_source = fixture.dependency_root.join("cores/esp32/core.cpp");
        let dependency_dir = fixture.dependency_root.join("sdk/final-seal");
        let core_only = dependency_dir.join("core-only.h");
        let core_object = fixture.build.join("core/core.cpp.o");
        let core_depfile = core_object.with_extension("d");
        write_file(&core_only, b"#pragma once\n");
        write_file(
            &core_depfile,
            format!(
                "{}: {} {}\n",
                core_object.display(),
                core_source.display(),
                core_only.display()
            )
            .as_bytes(),
        );
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let expected = capture_esp32_library_relink_manifest(input).expect("capture baseline");
        let seal = refresh_esp32_library_relink_manifest_with_final_seal(&expected, input)
            .expect("complete pre-link refresh");

        let outside = fixture._root.path().join("outside-final-seal-dependency");
        std::fs::rename(&dependency_dir, &outside).expect("move dependency outside");
        junction::create(&outside, &dependency_dir).expect("replace dependency with junction");
        let error = finalize_esp32_library_relink_refresh_seal(seal)
            .expect_err("same-path reparse replacement must fail closed");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::UnsafePath);
        junction::delete(&dependency_dir).expect("delete dependency junction");
        std::fs::rename(&outside, &dependency_dir).expect("restore dependency directory");
    }

    #[cfg(windows)]
    #[test]
    fn final_seal_rejects_elf_or_map_reparse_replacement() {
        for output_kind in ["elf", "map"] {
            let fixture = make_fixture();
            let libraries = vec![fixture.library.clone()];
            let tools = vec![fixture.tool_root.clone()];
            let working = vec![fixture.working_root.clone()];
            let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
            let link_inputs = vec![
                fixture.sketch_object.clone(),
                fixture.library_object.clone(),
            ];
            let input = capture_input(
                &fixture,
                &libraries,
                &tools,
                &working,
                &dependencies,
                &link_inputs,
            );
            let expected = capture_esp32_library_relink_manifest(input).expect("capture baseline");
            let seal = refresh_esp32_library_relink_manifest_with_final_seal(&expected, input)
                .expect("complete pre-link refresh");
            let output = PathBuf::from(match output_kind {
                "elf" => &expected.native_link.elf_output,
                "map" => &expected.native_link.map_output,
                _ => unreachable!(),
            });
            std::fs::remove_file(&output).expect("remove ordinary link output");
            let outside = fixture
                ._root
                .path()
                .join(format!("outside-final-{output_kind}"));
            std::fs::create_dir_all(&outside).expect("outside output directory");
            junction::create(&outside, &output).expect("replace output with junction");

            let error = finalize_esp32_library_relink_refresh_seal(seal)
                .expect_err("post-link output reparse replacement must fail closed");
            assert_eq!(
                error.code,
                Esp32LibraryRelinkGateCode::UnsafePath,
                "output: {output_kind}"
            );
            junction::delete(&output).expect("delete output junction");
        }
    }

    #[test]
    fn validation_rejects_same_path_linker_content_replacement() {
        let fixture = make_fixture();
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let manifest = capture_esp32_library_relink_manifest(input).expect("capture manifest");
        write_file(Path::new(&fixture.link_argv[0]), b"replacement compiler");
        let error = validate_esp32_library_relink_manifest(&manifest, input)
            .expect_err("same-path linker replacement must fail");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
    }

    #[test]
    fn validation_rejects_same_path_core_archive_content_replacement() {
        let fixture = make_fixture();
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let manifest = capture_esp32_library_relink_manifest(input).expect("capture manifest");
        write_file(&fixture.core_archive, b"changed core archive");
        let error = validate_esp32_library_relink_manifest(&manifest, input)
            .expect_err("same-path Core archive replacement must fail");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::EvidenceMismatch);
    }

    #[test]
    fn capture_rejects_missing_or_out_of_root_core_dependency() {
        let fixture = make_fixture();
        let core_source = fixture.dependency_root.join("cores/esp32/core.cpp");
        let core_depfile = fixture.build.join("core/core.cpp.d");
        let missing = fixture.dependency_root.join("cores/esp32/missing.h");
        write_file(
            &core_depfile,
            format!(
                "{}: {} {}\n",
                fixture.build.join("core/core.cpp.o").display(),
                core_source.display(),
                missing.display()
            )
            .as_bytes(),
        );
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let error = capture_esp32_library_relink_manifest(input)
            .expect_err("missing Core dependency must fail closed");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::MissingEvidence);

        let outside = fixture._root.path().join("outside/header.h");
        write_file(&outside, b"#pragma once\n");
        write_file(
            &core_depfile,
            format!(
                "{}: {} {}\n",
                fixture.build.join("core/core.cpp.o").display(),
                core_source.display(),
                outside.display()
            )
            .as_bytes(),
        );
        let error = capture_esp32_library_relink_manifest(input)
            .expect_err("out-of-root Core dependency must fail closed");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::PathEscape);
    }

    #[cfg(windows)]
    #[test]
    fn capture_rejects_reparse_backed_core_dependency() {
        let fixture = make_fixture();
        let core_source = fixture.dependency_root.join("cores/esp32/core.cpp");
        let core_depfile = fixture.build.join("core/core.cpp.d");
        let outside = fixture._root.path().join("outside-core-dependency");
        let linked = fixture.dependency_root.join("linked-core-dependency");
        write_file(&outside.join("header.h"), b"#pragma once\n");
        junction::create(&outside, &linked).expect("dependency junction");
        write_file(
            &core_depfile,
            format!(
                "{}: {} {}\n",
                fixture.build.join("core/core.cpp.o").display(),
                core_source.display(),
                linked.join("header.h").display()
            )
            .as_bytes(),
        );
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let error = capture_esp32_library_relink_manifest(input)
            .expect_err("reparse-backed Core dependency must fail closed");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::UnsafePath);
        junction::delete(&linked).expect("delete dependency junction");
    }

    #[test]
    fn capture_rejects_library_object_outside_build_root() {
        let fixture = make_fixture();
        let outside_object = fixture.library.join("outside.o");
        write_file(&outside_object, b"outside object");
        write_file(
            &outside_object.with_extension("d"),
            format!(
                "{}: {}\n",
                outside_object.display(),
                fixture.library_source.display()
            )
            .as_bytes(),
        );
        let mut entries: Vec<CcdbEntry> =
            serde_json::from_slice(&std::fs::read(&fixture.ccdb).expect("read CCDB"))
                .expect("parse CCDB");
        let library_entry = entries.last_mut().expect("library row");
        library_entry.arguments.pop();
        library_entry
            .arguments
            .push(outside_object.to_string_lossy().into_owned());
        library_entry.output = Some(outside_object.to_string_lossy().into_owned());
        write_file(
            &fixture.ccdb,
            &serde_json::to_vec_pretty(&entries).expect("CCDB JSON"),
        );
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![fixture.sketch_object.clone(), outside_object];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let error = capture_esp32_library_relink_manifest(input)
            .expect_err("object escape must fail closed");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::PathEscape);
    }

    #[test]
    fn capture_rejects_archive_or_custom_link_library_semantics() {
        let fixture = make_fixture();
        write_file(
            &fixture.library.join("library.properties"),
            b"name=Foo\ndot_a_linkage=true\n",
        );
        let libraries = vec![fixture.library.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let error = capture_esp32_library_relink_manifest(input)
            .expect_err("archive semantics must fail closed");
        assert_eq!(
            error.code,
            Esp32LibraryRelinkGateCode::UnsupportedLibrarySemantics
        );
    }

    #[cfg(unix)]
    #[test]
    fn capture_rejects_symlink_backed_library_root() {
        use std::os::unix::fs::symlink;

        let fixture = make_fixture();
        let linked = fixture._root.path().join("linked-library");
        symlink(&fixture.library, &linked).expect("library symlink");
        let libraries = vec![linked];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let error = capture_esp32_library_relink_manifest(input)
            .expect_err("symlink root must fail closed");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::UnsafePath);
    }

    #[cfg(windows)]
    #[test]
    fn capture_rejects_reparse_backed_library_root() {
        let fixture = make_fixture();
        let linked = fixture._root.path().join("linked-library");
        junction::create(&fixture.library, &linked).expect("library junction");
        let libraries = vec![linked.clone()];
        let tools = vec![fixture.tool_root.clone()];
        let working = vec![fixture.working_root.clone()];
        let dependencies = vec![fixture.build.clone(), fixture.dependency_root.clone()];
        let link_inputs = vec![
            fixture.sketch_object.clone(),
            fixture.library_object.clone(),
        ];
        let input = capture_input(
            &fixture,
            &libraries,
            &tools,
            &working,
            &dependencies,
            &link_inputs,
        );
        let error = capture_esp32_library_relink_manifest(input)
            .expect_err("junction root must fail closed");
        assert_eq!(error.code, Esp32LibraryRelinkGateCode::UnsafePath);
        junction::delete(&linked).expect("delete library junction");
    }
}
