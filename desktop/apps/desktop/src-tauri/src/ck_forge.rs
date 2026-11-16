//! CK Forge v1 compatibility routing.
//!
//! This module deliberately separates the product identity (`ck-forge`) from
//! the existing compiler profile and cache contracts. A caller may use the
//! decision to select `PortableFast`, `QuickFast`, `SharedFast`, or `Release`,
//! but this module does not rename those profiles or mutate caches.
//!
//! Compatibility is conservative: an unknown platform or Core version falls
//! back to the unmodified platform-native `Release` path. A complete target
//! identity may enter a fast profile only when its qualification includes a
//! no-regression A/B comparison against the same Arduino CLI invocation. An
//! unknown target is therefore never blocked, but it is also never advertised
//! as fast merely because generic caching was enabled.

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

pub const CK_FORGE_ENGINE_ID: &str = "ck-forge";
pub const CK_FORGE_SCHEMA_VERSION: u32 = 1;
pub const CK_FORGE_PRODUCT_VERSION: &str = "1";
const CK_FORGE_QUALIFIED_ARDUINO_CLI_VERSION: &str = "1.4.1";
const CK_FORGE_QUALIFICATION_MANIFEST_JSON: &str =
    include_str!("ck_forge_qualified_targets.v1.json");
const CK_FORGE_PORTABLE_TOOLCHAIN_MIGRATION_JSON: &str =
    include_str!("ck_forge_portable_toolchains.v1.json");
const CK_FORGE_PORTABLE_TOOLCHAIN_IDENTITY_SCHEMA: &str =
    "ck_toolchain_cache_key_v13_portable_inputs";
const MAX_PORTABLE_TOOLCHAIN_MIGRATION_ENTRIES: usize = 512;

// The CN package index labels the byte-identical ESP32 3.3.6 archive as
// `3.3.6-cn`.  Keep the archive identity here as a *transient input proof*,
// not as a version alias or a certificate field.  A caller may offer the
// proof only after reading the package-manager receipt; Forge still requires
// the normal complete FQBN, CLI, host and toolchain gates below.  In
// particular, a matching archive checksum alone never grants Fast.
pub const ESP32_3_3_6_ARCHIVE_SHA256: &str =
    "bd0cf5e9062d5411470d216f5c24fcc3f269b3d23a8d7c4b34f981cc92e61755";
pub const ESP32_3_3_6_ARCHIVE_SIZE: u64 = 27_532_204;
const ESP32_3_3_6_CN_VERSION: &str = "3.3.6-cn";
const ESP32_3_3_6_CANONICAL_VERSION: &str = "3.3.6";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableToolchainMigrationIndex {
    schema_id: String,
    schema_version: u32,
    identity_schema: String,
    entries: Vec<PortableToolchainMigrationEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableToolchainMigrationEntry {
    fqbn: String,
    core_version: String,
    portable_toolchain_key: String,
    evidence_toolchain_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct BuiltinQualificationTarget {
    canonical_fqbn: String,
    core_version: String,
    toolchain_key: String,
    /// Optional during migration from the old correctness-only matrix. A row
    /// without this evidence remains useful for diagnostics, but cannot grant
    /// a fast route.
    #[serde(default)]
    performance_ab: Vec<ForgePerformanceEvidence>,
}

/// The operation whose route was compared with native Arduino CLI. Compile
/// and upload-ready packaging are deliberately distinct: a faster compile is
/// not evidence that skipped packaging hooks are safe for an upload.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum ForgePerformanceOperation {
    Compile,
    UploadReady,
}

/// Exact CK profile measured by one A/B certificate.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum ForgePerformanceProfile {
    PortableFast,
    QuickFast,
    SharedFast,
    NativeRelinkCompileOnly,
}

/// One explicitly requested performance probe. This is not a product route
/// grant: callers must still authenticate the qualification request, and a
/// passing measurement must be evaluated and installed as a certificate
/// before normal builds may use the measured profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForgeQualificationProbe {
    pub operation: ForgePerformanceOperation,
    pub profile: ForgePerformanceProfile,
}

impl ForgeQualificationProbe {
    pub fn parse(operation: &str, profile: &str) -> Result<Self, String> {
        let operation = match operation.trim() {
            "compile" => ForgePerformanceOperation::Compile,
            "upload-ready" => ForgePerformanceOperation::UploadReady,
            _ => {
                return Err(
                    "CK Forge qualification operation must be compile or upload-ready.".to_string(),
                );
            }
        };
        let profile = match profile.trim() {
            "portable-fast" => ForgePerformanceProfile::PortableFast,
            "quick-fast" => ForgePerformanceProfile::QuickFast,
            "shared-fast" => ForgePerformanceProfile::SharedFast,
            _ => return Err(
                "CK Forge qualification profile must be portable-fast, quick-fast, or shared-fast."
                    .to_string(),
            ),
        };
        if !supported_performance_operation_profile(operation, profile) {
            return Err(
                "CK Forge supports portable-fast only for compile; quick-fast for compile or upload-ready; shared-fast is upload-ready evidence."
                    .to_string(),
            );
        }
        Ok(Self { operation, profile })
    }

    pub fn operation_label(self) -> &'static str {
        match self.operation {
            ForgePerformanceOperation::Compile => "compile",
            ForgePerformanceOperation::UploadReady => "upload-ready",
        }
    }

    pub fn profile_label(self) -> &'static str {
        match self.profile {
            ForgePerformanceProfile::PortableFast => "portable-fast",
            ForgePerformanceProfile::QuickFast => "quick-fast",
            ForgePerformanceProfile::SharedFast => "shared-fast",
            ForgePerformanceProfile::NativeRelinkCompileOnly => {
                unreachable!("NativeRelink uses its dedicated qualification contract")
            }
        }
    }
}

/// Performance evidence required to promote one exact host/Core/toolchain/FQBN
/// identity into the fast lane.
///
/// Current local certificates are reconstructed from the fixed portable-edit
/// sequence. Every stage must improve by at least twenty-five percent and 500ms,
/// candidate p95 must not regress, and every coefficient of variation must be
/// at most twenty percent. The legacy `fresh` fields retain the simple-stage
/// summary and the `repeat` fields retain the weakest passing edit-stage
/// summary so the public routing shape stays compatible. Artifact and resource
/// equivalence are independently revalidated for every paired stage.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForgePerformanceEvidence {
    pub operation: ForgePerformanceOperation,
    pub candidate_profile: ForgePerformanceProfile,
    /// Privacy-preserving fingerprint of the machine and CK sysroot used for
    /// the A/B capture. OS/architecture alone is never sufficient.
    pub host_identity_sha256: String,
    /// SHA-256 of the immutable raw paired-sample document evaluated by the
    /// versioned protocol. This prevents summary-only/self-asserted evidence.
    pub sample_set_sha256: String,
    pub samples_per_lane: u32,
    pub native_fresh_median_ms: u64,
    pub candidate_fresh_median_ms: u64,
    pub native_repeat_median_ms: u64,
    pub candidate_repeat_median_ms: u64,
    pub native_fresh_p95_ms: u64,
    pub candidate_fresh_p95_ms: u64,
    pub native_repeat_p95_ms: u64,
    pub candidate_repeat_p95_ms: u64,
    pub native_fresh_cv_basis_points: u32,
    pub candidate_fresh_cv_basis_points: u32,
    pub native_repeat_cv_basis_points: u32,
    pub candidate_repeat_cv_basis_points: u32,
    pub artifact_equivalent: bool,
    pub resource_equivalent: bool,
    pub evidence_sha256: String,
    pub artifact_set_sha256: String,
}

const MIN_PERFORMANCE_SAMPLES_PER_LANE: u32 = 5;
const MAX_PERFORMANCE_SAMPLES_PER_LANE: u32 = 25;
const MIN_IMPROVEMENT_BASIS_POINTS: u128 = 2_500;
const MIN_ABSOLUTE_SAVING_MS: u64 = 500;
const MAX_CV_BASIS_POINTS: u32 = 2_000;

fn median_improves(native_ms: u64, candidate_ms: u64) -> bool {
    native_ms > 0
        && candidate_ms > 0
        && native_ms.saturating_sub(candidate_ms) >= MIN_ABSOLUTE_SAVING_MS
        && (candidate_ms as u128) * 10_000
            <= (native_ms as u128) * (10_000 - MIN_IMPROVEMENT_BASIS_POINTS)
}

fn sha256_text_is_valid(value: &str) -> bool {
    let value = value.trim();
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn toolchain_content_sha256(toolchain_key: &str) -> Option<&str> {
    let (_, digest) = toolchain_key.rsplit_once('|')?;
    sha256_text_is_valid(digest).then_some(digest)
}

fn supported_performance_operation_profile(
    operation: ForgePerformanceOperation,
    profile: ForgePerformanceProfile,
) -> bool {
    matches!(
        (operation, profile),
        (
            ForgePerformanceOperation::Compile,
            ForgePerformanceProfile::PortableFast
        ) | (
            ForgePerformanceOperation::Compile,
            ForgePerformanceProfile::QuickFast
        ) | (
            ForgePerformanceOperation::UploadReady,
            ForgePerformanceProfile::QuickFast
        ) | (
            ForgePerformanceOperation::UploadReady,
            ForgePerformanceProfile::SharedFast
        )
    )
}

fn performance_ab_passes(evidence: &ForgePerformanceEvidence) -> bool {
    supported_performance_operation_profile(evidence.operation, evidence.candidate_profile)
        && evidence.samples_per_lane >= MIN_PERFORMANCE_SAMPLES_PER_LANE
        && evidence.samples_per_lane <= MAX_PERFORMANCE_SAMPLES_PER_LANE
        && median_improves(
            evidence.native_fresh_median_ms,
            evidence.candidate_fresh_median_ms,
        )
        && median_improves(
            evidence.native_repeat_median_ms,
            evidence.candidate_repeat_median_ms,
        )
        && evidence.native_fresh_p95_ms >= evidence.native_fresh_median_ms
        && evidence.candidate_fresh_p95_ms >= evidence.candidate_fresh_median_ms
        && evidence.native_repeat_p95_ms >= evidence.native_repeat_median_ms
        && evidence.candidate_repeat_p95_ms >= evidence.candidate_repeat_median_ms
        && evidence.candidate_fresh_p95_ms <= evidence.native_fresh_p95_ms
        && evidence.candidate_repeat_p95_ms <= evidence.native_repeat_p95_ms
        && evidence.native_fresh_cv_basis_points <= MAX_CV_BASIS_POINTS
        && evidence.candidate_fresh_cv_basis_points <= MAX_CV_BASIS_POINTS
        && evidence.native_repeat_cv_basis_points <= MAX_CV_BASIS_POINTS
        && evidence.candidate_repeat_cv_basis_points <= MAX_CV_BASIS_POINTS
        && evidence.artifact_equivalent
        && evidence.resource_equivalent
        && sha256_text_is_valid(&evidence.host_identity_sha256)
        && sha256_text_is_valid(&evidence.sample_set_sha256)
        && sha256_text_is_valid(&evidence.evidence_sha256)
        && sha256_text_is_valid(&evidence.artifact_set_sha256)
}

const HOST_ENVIRONMENT_FINGERPRINT_DOMAIN: &[u8] = b"ck-forge-host-environment-v2\0";
const HOST_ENVIRONMENT_KEYS: [&str; 5] = [
    "COMPUTERNAME",
    "HOSTNAME",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
];

fn normalized_host_os(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "win32" | "windows" => "windows".to_string(),
        "darwin" | "macos" | "osx" => "macos".to_string(),
        "linux" => "linux".to_string(),
        other => other.to_string(),
    }
}

fn normalized_host_arch(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "x64" | "amd64" | "x86_64" => "x86_64".to_string(),
        "ia32" | "i386" | "i486" | "i586" | "i686" | "x86" => "x86".to_string(),
        "arm64" | "aarch64" => "aarch64".to_string(),
        other => other.to_string(),
    }
}

fn normalized_host_sysroot(value: &str, normalized_os: &str) -> String {
    let mut normalized = value.replace('\\', "/");
    if normalized_os == "windows" {
        if let Some(rest) = normalized.strip_prefix("//?/UNC/") {
            normalized = format!("//{rest}");
        } else if let Some(rest) = normalized.strip_prefix("//?/") {
            normalized = rest.to_string();
        }
        normalized.make_ascii_lowercase();
    }
    while normalized.ends_with('/')
        && normalized.len() > 1
        && !(normalized_os == "windows"
            && normalized.len() == 3
            && normalized.as_bytes().get(1) == Some(&b':'))
    {
        normalized.pop();
    }
    normalized
}

/// Cross-language v2 byte contract used by the Rust loader and the Node A/B
/// runner. Each UTF-8 field is framed with an unsigned 64-bit little-endian
/// byte length, so environment values cannot alter field boundaries.
pub(crate) fn host_environment_fingerprint_from_parts(
    host_os: &str,
    host_arch: &str,
    canonical_sysroot: &str,
    environment: &std::collections::BTreeMap<String, String>,
) -> String {
    let normalized_os = normalized_host_os(host_os);
    let fields = std::iter::once(format!("os={normalized_os}"))
        .chain(std::iter::once(format!(
            "arch={}",
            normalized_host_arch(host_arch)
        )))
        .chain(std::iter::once(format!(
            "sysroot={}",
            normalized_host_sysroot(canonical_sysroot, &normalized_os)
        )))
        .chain(HOST_ENVIRONMENT_KEYS.into_iter().map(|key| {
            format!(
                "{key}={}",
                environment
                    .get(key)
                    .map(String::as_str)
                    .unwrap_or("<unset>")
            )
        }));
    let mut hasher = Sha256::new();
    hasher.update(HOST_ENVIRONMENT_FINGERPRINT_DOMAIN);
    for field in fields {
        let bytes = field.as_bytes();
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    format!("{:x}", hasher.finalize())
}

/// Stable, privacy-preserving environment binding for local performance
/// evidence. The digest intentionally includes the canonical CK sysroot and
/// host-specific identifiers so a generic host label cannot silently unlock
/// another computer. Raw identifiers are never persisted.
pub fn host_environment_fingerprint(sysroot_root: &std::path::Path) -> String {
    let canonical_root = sysroot_root
        .canonicalize()
        .unwrap_or_else(|_| sysroot_root.to_path_buf());
    let environment = HOST_ENVIRONMENT_KEYS
        .into_iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| (key.to_string(), value))
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    host_environment_fingerprint_from_parts(
        std::env::consts::OS,
        std::env::consts::ARCH,
        &canonical_root.to_string_lossy(),
        &environment,
    )
}

const LOCAL_QUALIFICATION_SCHEMA_ID: &str = "ck.forge.local-performance-certificate";
const MAX_BUNDLED_QUALIFICATION_HINT_SCAN: usize = 512;
const MAX_BUNDLED_PERFORMANCE_DIRECTORY_PROBES: usize = 512;

static BUNDLED_NATIVE_RELINK_ROOTS: OnceLock<Vec<PathBuf>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct NativeRelinkHintKey {
    fqbn: String,
    core_version: String,
    cli_version: String,
    toolchain_key: String,
    adapter_id: String,
}

#[derive(Debug)]
struct NativeRelinkRootHintIndex {
    root_modified: Option<std::time::SystemTime>,
    entries: HashMap<NativeRelinkHintKey, Vec<PathBuf>>,
    complete: bool,
}

fn native_relink_hint_indexes() -> &'static Mutex<HashMap<PathBuf, NativeRelinkRootHintIndex>> {
    static INDEXES: OnceLock<Mutex<HashMap<PathBuf, NativeRelinkRootHintIndex>>> = OnceLock::new();
    INDEXES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register the Tauri-resolved resource directory before any build command
/// runs. Installer targets are allowed to place resources outside the EXE
/// directory, so the authoritative resource path must come from Tauri rather
/// than from a guessed relative path. This is process-local and read-only.
pub fn register_bundled_native_relink_resource_root(resource_root: &Path) {
    let roots = vec![
        resource_root.join("state").join("qualifications"),
        resource_root
            .join("resources")
            .join("state")
            .join("qualifications"),
        resource_root.join("qualifications"),
    ];
    let _ = BUNDLED_NATIVE_RELINK_ROOTS.set(roots);
}

/// Build the read-only NativeRelink target hint table while the desktop is
/// idle.  The table is only a directory locator; every later authorization
/// still performs the existing certificate, evidence, report, executable,
/// CLI, Core, toolchain, artifact and performance validation.
pub fn prime_native_relink_hint_indexes(sysroot_root: &Path) -> usize {
    let mut roots = vec![sysroot_root.join("state").join("qualifications")];
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            roots.extend([
                parent.join("state").join("qualifications"),
                parent
                    .join("resources")
                    .join("state")
                    .join("qualifications"),
                parent.join("resources").join("qualifications"),
            ]);
        }
    }
    if let Some(registered) = BUNDLED_NATIVE_RELINK_ROOTS.get() {
        roots.extend(registered.iter().cloned());
    }

    let mut indexed = 0_usize;
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        let Ok(canonical_root) = root.canonicalize() else {
            continue;
        };
        if !seen.insert(canonical_root.clone()) {
            continue;
        }
        if ensure_native_relink_root_hint_index(&root, &canonical_root) {
            indexed = indexed.saturating_add(1);
        }
    }
    indexed
}

/// Arduino AVR exposes these boards as a base FQBN while the Core resolves a
/// default CPU menu behind the scenes. NativeRelink certificates are bound to
/// the complete target, so use the Core's default menu only for a base lookup;
/// an explicit menu option remains untouched.
fn native_relink_default_complete_fqbn(fqbn: &str) -> String {
    match fqbn.trim() {
        "arduino:avr:diecimila" => "arduino:avr:diecimila:cpu=atmega328".to_string(),
        "arduino:avr:nano" => "arduino:avr:nano:cpu=atmega328".to_string(),
        "arduino:avr:mega" => "arduino:avr:mega:cpu=atmega2560".to_string(),
        other => other.to_string(),
    }
}
const LOCAL_ARTIFACT_SET_SCHEMA_ID: &str = "ck.forge.qualification-artifact-set";
const PERFORMANCE_CANDIDATE_SCHEMA_ID: &str = "ck.forge.performance-ab-candidate";
const PERFORMANCE_REPORT_SCHEMA_ID: &str = "ck.forge.performance-qualification-report";
const PERFORMANCE_POLICY_ID: &str = "ck-forge-portable-edit-no-regression-v3";
const QUALIFICATION_TOKEN_CANDIDATE_ROUTE: &str = "qualification-token-probe";
const PORTABLE_FAST_RECIPE_INTENT: &str = "native-recipe-cache";
// Generic performance evidence v4 binds the observed candidate execution
// route and build mode for every CK sample. The local certificate envelope
// intentionally remains v2: its hashes bind the versioned candidate/report
// payloads, while v3 payloads must now fail closed below.
const PERFORMANCE_CANDIDATE_SCHEMA_VERSION: u64 = 4;
const PERFORMANCE_REPORT_SCHEMA_VERSION: u64 = 4;
const PERFORMANCE_MEASUREMENT_SEQUENCE: &str = "portable-edit";
const GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID: &str = "generic-required-role-content-exact-v1";
const PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID: &str =
    "portable-fast-esp-application-bin-elf-sha256-offset-flash-args-normalized-v2";
const ESP_APPLICATION_BIN_RECIPE_PROOF_SCHEMA_VERSION: u64 = 1;
const ESP_APPLICATION_BIN_RECIPE_PROOF_KIND: &str = "esp32-platform-recipe-elf-sha256-offset-v1";
const ESP_APPLICATION_BIN_RECIPE_PROPERTY: &str = "recipe.objcopy.bin.pattern_args";
const ESP_APPLICATION_BIN_PAYLOAD_WITNESS_SCHEMA_VERSION: u64 = 1;
const ESP_APPLICATION_BIN_PAYLOAD_WITNESS_KIND: &str = "esp-application-bin-elf-sha256-offset-v1";
const ESP_APPLICATION_BIN_ELF_SHA256_OFFSET: u64 = 0xb0;
const ESP_APPLICATION_BIN_ELF_SHA256_LENGTH: u64 = 32;
const ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH: u64 = 33;
const ESP_APPLICATION_BIN_ELF_SHA256_ARGUMENT: &str = "--elf-sha256-offset 0xb0";
const ESP_FLASH_ARGS_WITNESS_SCHEMA_VERSION: u64 = 1;
const ESP_FLASH_ARGS_WITNESS_KIND: &str = "esp-flash-args-normalized-v1";
// Mirrors the runner's PortableFast compile-only exclusions: derived non-flash
// byproducts must stay count-symmetric across lanes, while CK's provenance
// upload manifest may only ever exist on the CK lane.
const PORTABLE_FAST_COMPILE_ONLY_EXCLUDED_ARTIFACT_ROLES: [&str; 3] =
    ["application-elf", "merged-firmware-bin", "upload-manifest"];
const COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID: &str =
    "compile-only-shared-primary-application-exact-v1";
const NATIVE_RELINK_RUN_SCHEMA_ID: &str = "ck.forge.native-ab-run";
const NATIVE_RELINK_REPORT_SCHEMA_ID: &str = "ck.forge.native-relink-local-qualification-report";
const NATIVE_RELINK_BINDING_SCHEMA_VERSION: u32 = 3;
const NATIVE_RELINK_PROFILE_ID: &str = "native-relink-compile-only";
const NATIVE_RELINK_POLICY_ID: &str = "ck-forge-portable-edit-performance-v3";

/// Description of one independently qualified NativeRelink lane.
///
/// The descriptor is the single source of truth for the identity strings and
/// artifact policy used by the evidence validator and local certificate
/// loader. Each entry remains a narrowly qualified board family; package or
/// architecture names alone never grant access.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeRelinkFqbnMatcher {
    Prefix(&'static str),
    ExactBase(&'static str),
}

impl NativeRelinkFqbnMatcher {
    fn matches(self, fqbn: &str) -> bool {
        match self {
            Self::Prefix(prefix) => fqbn.starts_with(prefix),
            Self::ExactBase(base) => {
                fqbn == base
                    || fqbn
                        .strip_prefix(base)
                        .is_some_and(|suffix| suffix.starts_with(':'))
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NativeRelinkAdapterDescriptor {
    id: &'static str,
    fqbn_matcher: NativeRelinkFqbnMatcher,
    core_architecture: &'static str,
    engine_contract_id: &'static str,
    artifact_policy_id: &'static str,
    required_artifact_roles: &'static [&'static str],
    // Witness roles are unique same-length primary images per lane whose
    // digests may differ only inside the validated ESP payload witness's
    // mutable window; every immutable segment must hash equal across lanes.
    witness_artifact_roles: &'static [&'static str],
    optional_artifact_roles: &'static [&'static str],
    forbidden_all_stage_artifact_roles: &'static [&'static str],
    forbidden_ck_edit_artifact_roles: &'static [&'static str],
}

const AVR_NATIVE_RELINK_ADAPTER: NativeRelinkAdapterDescriptor = NativeRelinkAdapterDescriptor {
    id: "arduino-avr-native-relink-v1",
    fqbn_matcher: NativeRelinkFqbnMatcher::Prefix("arduino:avr:"),
    core_architecture: "avr",
    // v2 changes the authenticated execution capability. Keeping the engine
    // ID in the qualification binding makes every Phase-1/v1 certificate
    // ineligible instead of silently widening its authorization.
    engine_contract_id: "ck-native-relink-avr-release-compile-only-v2",
    artifact_policy_id: "arduino-avr-hex-required-eeprom-optional-exact-v2",
    // Some AVR Core/build-route combinations omit an empty EEPROM image. It
    // is optional only when both lanes omit it; an emitted image stays exact.
    required_artifact_roles: &["avr-application-hex"],
    witness_artifact_roles: &[],
    optional_artifact_roles: &["avr-eeprom"],
    forbidden_all_stage_artifact_roles: &[],
    forbidden_ck_edit_artifact_roles: &["avr-with-bootloader"],
};

const SAMD_MKRZERO_NATIVE_RELINK_ADAPTER: NativeRelinkAdapterDescriptor =
    NativeRelinkAdapterDescriptor {
        id: "arduino-samd-mkrzero-native-relink-v1",
        fqbn_matcher: NativeRelinkFqbnMatcher::ExactBase("arduino:samd:mkrzero"),
        core_architecture: "samd",
        engine_contract_id: "ck-native-relink-samd-release-compile-only-phase1-v1",
        artifact_policy_id: "arduino-samd-app-bin-hex-exact-ck-edit-no-bootloader-v2",
        // Native Arduino CLI may emit with_bootloader images.  The
        // compile-only transaction removes them before committing CK edit
        // output, so only CK edit lanes forbid those stale upload artifacts.
        required_artifact_roles: &["samd-application-bin", "samd-application-hex"],
        witness_artifact_roles: &[],
        optional_artifact_roles: &[],
        forbidden_all_stage_artifact_roles: &[
            "samd-uf2",
            "flash-arguments",
            "upload-manifest",
            "avr-eeprom",
            "auxiliary-firmware",
        ],
        forbidden_ck_edit_artifact_roles: &["samd-with-bootloader-bin", "samd-with-bootloader-hex"],
    };

/// Every ESP32-family adapter shares the phase-1 engine contract and artifact
/// policy: bootloader/partitions stay byte-exact while the application image
/// (which embeds the lane-local ELF SHA-256 digest, making cross-lane byte
/// equality impossible) rides the existing validated ESP payload witness.
/// Each base FQBN remains an independently qualified adapter row; coverage
/// grows base by base together with per-board A/B evidence.
const fn esp32_native_relink_adapter(
    id: &'static str,
    fqbn_base: &'static str,
) -> NativeRelinkAdapterDescriptor {
    NativeRelinkAdapterDescriptor {
        id,
        fqbn_matcher: NativeRelinkFqbnMatcher::ExactBase(fqbn_base),
        core_architecture: "esp32",
        engine_contract_id: "ck-native-relink-esp32-release-compile-only-phase1-v1",
        artifact_policy_id: "esp32-app-bin-witness-bootloader-partitions-exact-v1",
        required_artifact_roles: &["bootloader-bin", "partitions-bin"],
        witness_artifact_roles: &["application-bin"],
        optional_artifact_roles: &[],
        forbidden_all_stage_artifact_roles: &[],
        forbidden_ck_edit_artifact_roles: &[],
    }
}

const ESP32C6_NATIVE_RELINK_ADAPTER: NativeRelinkAdapterDescriptor =
    esp32_native_relink_adapter("esp32-esp32c6-native-relink-v1", "esp32:esp32:esp32c6");
const ESP32_NATIVE_RELINK_ADAPTER: NativeRelinkAdapterDescriptor =
    esp32_native_relink_adapter("esp32-esp32-native-relink-v1", "esp32:esp32:esp32");
const ESP32S2_NATIVE_RELINK_ADAPTER: NativeRelinkAdapterDescriptor =
    esp32_native_relink_adapter("esp32-esp32s2-native-relink-v1", "esp32:esp32:esp32s2");
const ESP32S3_NATIVE_RELINK_ADAPTER: NativeRelinkAdapterDescriptor =
    esp32_native_relink_adapter("esp32-esp32s3-native-relink-v1", "esp32:esp32:esp32s3");
const ESP32C3_NATIVE_RELINK_ADAPTER: NativeRelinkAdapterDescriptor =
    esp32_native_relink_adapter("esp32-esp32c3-native-relink-v1", "esp32:esp32:esp32c3");
const ESP32C5_NATIVE_RELINK_ADAPTER: NativeRelinkAdapterDescriptor =
    esp32_native_relink_adapter("esp32-esp32c5-native-relink-v1", "esp32:esp32:esp32c5");
const ESP32H2_NATIVE_RELINK_ADAPTER: NativeRelinkAdapterDescriptor =
    esp32_native_relink_adapter("esp32-esp32h2-native-relink-v1", "esp32:esp32:esp32h2");
const ESP32P4_NATIVE_RELINK_ADAPTER: NativeRelinkAdapterDescriptor =
    esp32_native_relink_adapter("esp32-esp32p4-native-relink-v1", "esp32:esp32:esp32p4");

const NATIVE_RELINK_ADAPTERS: &[NativeRelinkAdapterDescriptor] = &[
    AVR_NATIVE_RELINK_ADAPTER,
    SAMD_MKRZERO_NATIVE_RELINK_ADAPTER,
    ESP32C6_NATIVE_RELINK_ADAPTER,
    ESP32_NATIVE_RELINK_ADAPTER,
    ESP32S2_NATIVE_RELINK_ADAPTER,
    ESP32S3_NATIVE_RELINK_ADAPTER,
    ESP32C3_NATIVE_RELINK_ADAPTER,
    ESP32C5_NATIVE_RELINK_ADAPTER,
    ESP32H2_NATIVE_RELINK_ADAPTER,
    ESP32P4_NATIVE_RELINK_ADAPTER,
];

/// Public for the existing desktop builder API; it remains the AVR contract
/// until a separately qualified adapter is intentionally enabled.
pub const CK_FORGE_NATIVE_RELINK_COMPILE_ONLY_CONTRACT_ID: &str =
    AVR_NATIVE_RELINK_ADAPTER.engine_contract_id;

fn native_relink_adapter_for(
    fqbn: &str,
    core_architecture: Option<&str>,
) -> Option<&'static NativeRelinkAdapterDescriptor> {
    let fqbn = fqbn.trim();
    NATIVE_RELINK_ADAPTERS.iter().find(|adapter| {
        adapter.fqbn_matcher.matches(fqbn)
            && core_architecture.is_none_or(|architecture| {
                architecture
                    .trim()
                    .eq_ignore_ascii_case(adapter.core_architecture)
            })
    })
}

pub(crate) fn native_relink_adapter_registered_for_fqbn(fqbn: &str) -> bool {
    let Some(parsed) = parse_complete_fqbn(fqbn) else {
        return false;
    };
    // Parse and canonicalize the complete FQBN before consulting the registry.
    // This rejects malformed/duplicate options while accepting a valid menu
    // selection regardless of the order in which Arduino supplied its keys,
    // matching the Node runner/evaluator contract.
    native_relink_adapter_for(&parsed.canonical_fqbn, None).is_some()
}
const NATIVE_RELINK_REQUIRED_TRIALS: usize = MIN_PERFORMANCE_SAMPLES_PER_LANE as usize;
const NATIVE_RELINK_EDIT_STAGES: [&str; 3] = ["complex", "medium", "simple-return"];
const PORTABLE_EDIT_STAGES: [(&str, &str); 4] = [
    (
        "simple",
        "9957ed4144a4dcb3ea6918ae021976812dda56d4da3815ef92ca29682e0fa0b5",
    ),
    (
        "complex",
        "ea468a750d243cc9a5a801d7bcd66a87e8daa2fdb535a783896fef99b0a0266e",
    ),
    (
        "medium",
        "1e41189bc6e324ef3e72a08adfceef99ed1a1c8153a6d0a5c0f98cb874b52d99",
    ),
    (
        "simple-return",
        "9957ed4144a4dcb3ea6918ae021976812dda56d4da3815ef92ca29682e0fa0b5",
    ),
];
// A small qualification store can use certificate/report metadata as a cheap
// denial-only hint before hashing the bundled CLI.  This is deliberately a
// scan budget, not a store-size limit: once the 65th entry is observed the
// loader skips sibling inspection, computes the strongly bound key, and reads
// only `root/<exact-key>`.  Old-executable certificates can therefore coexist
// with the current one without disabling every qualified target.
const MAX_LOCAL_QUALIFICATION_HINT_SCAN: usize = 64;
// Legacy v2 performance certificates do not have enough request-side data to
// derive all possible keys. Keep their own candidate limit and a separate,
// bounded directory-probe ceiling. NativeRelink v4 does not use these limits.
const MAX_LOCAL_PERFORMANCE_QUALIFICATIONS: usize = 64;
const MAX_LOCAL_PERFORMANCE_DIRECTORY_PROBES: usize = 1_024;
const MAX_QUALIFICATION_CERTIFICATE_BYTES: u64 = 16 * 1024;
const MAX_QUALIFICATION_JSON_BYTES: u64 = 4 * 1024 * 1024;
const MAX_QUALIFICATION_ARTIFACTS: usize = 64;
const MAX_QUALIFICATION_ARTIFACT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_QUALIFICATION_ARTIFACT_SET_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalPerformanceCertificate {
    schema_id: String,
    schema_version: u32,
    candidate_sha256: String,
    report_sha256: String,
    artifact_manifest_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalNativeRelinkCertificate {
    schema_id: String,
    schema_version: u32,
    candidate_profile: String,
    evidence_sha256: String,
    report_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalArtifactSetManifest {
    schema_id: String,
    schema_version: u32,
    artifacts: Vec<LocalArtifactEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalArtifactEntry {
    path: String,
    size: u64,
    sha256: String,
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
std::thread_local! {
    static QUALIFICATION_CLI_FILE_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn reset_qualification_cli_file_reads() {
    QUALIFICATION_CLI_FILE_READS.with(|count| count.set(0));
}

#[cfg(test)]
fn qualification_cli_file_reads() -> usize {
    QUALIFICATION_CLI_FILE_READS.with(std::cell::Cell::get)
}

#[cfg(test)]
fn note_qualification_cli_file_read(path: &std::path::Path) {
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case("arduino-cli") || name.eq_ignore_ascii_case("arduino-cli.exe")
        })
    {
        QUALIFICATION_CLI_FILE_READS.with(|count| count.set(count.get().saturating_add(1)));
    }
}

#[cfg(not(test))]
fn note_qualification_cli_file_read(_path: &std::path::Path) {}

fn read_bounded_file(path: &std::path::Path, max_bytes: u64) -> Option<Vec<u8>> {
    note_qualification_cli_file_read(path);
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > max_bytes {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let mut bytes =
        Vec::with_capacity(usize::try_from(metadata.len().min(max_bytes)).unwrap_or_default());
    std::io::Read::read_to_end(&mut file.take(max_bytes.saturating_add(1)), &mut bytes).ok()?;
    (bytes.len() as u64 <= max_bytes).then_some(bytes)
}

#[derive(Debug, Clone)]
struct ManagedCliExecutableIdentity {
    canonical_path: PathBuf,
    len: u64,
    modified: Option<std::time::SystemTime>,
    sha256: String,
    // On Windows this handle permits only other readers. The authenticated
    // executable therefore cannot be rewritten or replaced behind the cached
    // digest while CK is running.
    _read_lock: Arc<std::fs::File>,
}

fn managed_cli_executable_identities()
-> &'static Mutex<HashMap<PathBuf, ManagedCliExecutableIdentity>> {
    static IDENTITIES: OnceLock<Mutex<HashMap<PathBuf, ManagedCliExecutableIdentity>>> =
        OnceLock::new();
    IDENTITIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn managed_cli_file_state(
    path: &std::path::Path,
) -> Option<(PathBuf, u64, Option<std::time::SystemTime>)> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let canonical_path = path.canonicalize().ok()?;
    let canonical_metadata = std::fs::symlink_metadata(&canonical_path).ok()?;
    if !canonical_metadata.is_file() || canonical_metadata.file_type().is_symlink() {
        return None;
    }
    Some((
        canonical_path,
        canonical_metadata.len(),
        canonical_metadata.modified().ok(),
    ))
}

fn open_managed_cli_read_lock(path: &std::path::Path) -> Option<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ only: arduino-cli may execute/read normally, while
        // mutation and replacement are denied until this identity is revoked.
        options.share_mode(0x0000_0001);
    }
    options.open(path).ok()
}

fn capture_managed_cli_executable_identity(
    path: &std::path::Path,
    max_bytes: u64,
) -> Option<ManagedCliExecutableIdentity> {
    let (canonical_path, len, modified) = managed_cli_file_state(path)?;
    if len > max_bytes {
        return None;
    }
    let read_lock = open_managed_cli_read_lock(&canonical_path)?;
    let locked_metadata = read_lock.metadata().ok()?;
    if !locked_metadata.is_file() || locked_metadata.len() != len {
        return None;
    }
    note_qualification_cli_file_read(&canonical_path);
    let reader = read_lock.try_clone().ok()?;
    let mut bytes = Vec::with_capacity(usize::try_from(len).unwrap_or_default());
    std::io::Read::read_to_end(&mut reader.take(max_bytes.saturating_add(1)), &mut bytes).ok()?;
    if bytes.len() as u64 > max_bytes {
        return None;
    }
    let after = managed_cli_file_state(&canonical_path)?;
    if after.0 != canonical_path || after.1 != len || after.2 != modified {
        return None;
    }
    Some(ManagedCliExecutableIdentity {
        canonical_path,
        len,
        modified,
        sha256: sha256_bytes(&bytes),
        _read_lock: Arc::new(read_lock),
    })
}

/// Reuse the SHA-256 that the atomic bundled-resource installer has already
/// computed and verified for the managed Arduino CLI.  Customer machines with
/// slow storage previously reread the same 30-40 MiB executable on every
/// Compile click, even though startup had just authenticated those exact bytes.
///
/// This is only an implementation identity cache: certificate/schema/policy
/// semantics are unchanged.  A path, length or modification change revokes the
/// entry and the foreground loader hashes the file again before authorizing.
pub fn register_managed_cli_executable_identity(
    path: &std::path::Path,
    sha256: &str,
) -> Result<(), String> {
    let sha256 = sha256.trim().to_ascii_lowercase();
    if !sha256_text_is_valid(&sha256) {
        return Err("managed Arduino CLI SHA-256 is invalid".to_string());
    }
    let identity = capture_managed_cli_executable_identity(path, MAX_QUALIFICATION_ARTIFACT_BYTES)
        .ok_or_else(|| {
            format!(
                "managed Arduino CLI could not be locked and authenticated: {}",
                path.display()
            )
        })?;
    if identity.sha256 != sha256 {
        return Err(format!(
            "managed Arduino CLI changed after installation: {}",
            path.display()
        ));
    }
    let canonical_path = identity.canonical_path.clone();
    let mut identities = managed_cli_executable_identities()
        .lock()
        .map_err(|_| "managed Arduino CLI identity cache is unavailable".to_string())?;
    identities.insert(canonical_path, identity);
    Ok(())
}

fn managed_cli_executable_sha256(path: &std::path::Path, max_bytes: u64) -> Option<String> {
    let (canonical_path, len, modified) = managed_cli_file_state(path)?;
    if len > max_bytes {
        return None;
    }
    #[cfg(windows)]
    {
        if let Some(identity) = managed_cli_executable_identities()
            .lock()
            .ok()
            .and_then(|identities| identities.get(&canonical_path).cloned())
            .filter(|identity| {
                identity.canonical_path == canonical_path
                    && identity.len == len
                    && identity.modified == modified
                    && sha256_text_is_valid(&identity.sha256)
            })
        {
            return Some(identity.sha256);
        }
    }

    let identity = capture_managed_cli_executable_identity(&canonical_path, max_bytes)?;
    let sha256 = identity.sha256.clone();
    managed_cli_executable_identities()
        .lock()
        .ok()?
        .insert(identity.canonical_path.clone(), identity);
    Some(sha256)
}

#[cfg(test)]
fn remove_managed_cli_executable_identity(path: &std::path::Path) {
    let Some((canonical_path, _, _)) = managed_cli_file_state(path) else {
        return;
    };
    if let Ok(mut identities) = managed_cli_executable_identities().lock() {
        identities.remove(&canonical_path);
    }
}

/// Hash the bytes of the executable that owns this running CK process.  A
/// NativeRelink certificate is an authorization for executable code, not just
/// for a Core/toolchain tuple, so rebuilding CK must invalidate every prior
/// certificate even when all Arduino inputs are unchanged.
fn current_production_executable_sha256() -> Option<String> {
    static EXECUTABLE_SHA256: OnceLock<Option<String>> = OnceLock::new();
    EXECUTABLE_SHA256
        .get_or_init(|| {
            let executable = std::env::current_exe().ok()?;
            Some(sha256_bytes(&read_bounded_file(
                &executable,
                MAX_QUALIFICATION_ARTIFACT_BYTES,
            )?))
        })
        .clone()
}

/// Prime the immutable production-executable identity before the first
/// foreground build.  Normal customer launches can pay this read-only hash
/// while the app is starting instead of making the first NativeRelink lookup
/// appear to be a compiler delay.  The same `OnceLock` value is still used by
/// the loader, so this does not bypass or weaken the executable binding; a
/// failed read remains a fail-closed `None`.
pub fn prime_current_production_executable_identity() {
    let _ = current_production_executable_sha256();
}

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::String(value) => {
            serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
        }
        serde_json::Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        serde_json::Value::Object(values) => {
            let mut fields = values.iter().collect::<Vec<_>>();
            fields.sort_by(|left, right| left.0.cmp(right.0));
            format!(
                "{{{}}}",
                fields
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn json_string<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

/// Keep proof fields byte-for-byte comparable with the JavaScript schema
/// validator. Unlike `json_string`, this deliberately does not trim input.
fn json_raw_string<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

/// Cheap, fail-closed prefilter used before hashing the bundled Arduino CLI.
/// A certificate rejected here could not pass `load_one_local_qualification`
/// because that loader accepts only this exact schema. A positive result is
/// never authorization; it merely allows the full hash/evidence validation to
/// run.
fn may_contain_local_performance_certificate(directory: &std::path::Path) -> bool {
    let Some(bytes) = read_bounded_file(
        &directory.join("certificate.json"),
        MAX_QUALIFICATION_CERTIFICATE_BYTES,
    ) else {
        return false;
    };
    serde_json::from_slice::<LocalPerformanceCertificate>(&bytes).is_ok_and(|certificate| {
        certificate.schema_id == LOCAL_QUALIFICATION_SCHEMA_ID && certificate.schema_version == 2
    })
}

/// Cheap denial-only identity hint for the legacy performance-certificate
/// loader.  A positive (or unknown/malformed) result merely permits the
/// expensive CLI/EXE hash and full artifact/evidence validation below; a
/// forged or malformed candidate can therefore cause extra work but can never
/// grant a fast route. Keeping this prefilter before
/// `read_bounded_file(arduino-cli)` avoids paying the 30-40 MiB executable read
/// for stale certificates from another board/Core.
fn may_match_local_performance_identity(
    directory: &std::path::Path,
    canonical_fqbn: &str,
    core_version: &str,
    cli_version: &str,
    toolchain_key: &str,
    host_identity_sha256: &str,
    sketch_sha256: &str,
) -> bool {
    let Some(candidate_bytes) = read_bounded_file(
        &directory.join("candidate.json"),
        MAX_QUALIFICATION_JSON_BYTES,
    ) else {
        // An unreadable candidate cannot prove a mismatch. Keep the original
        // full-loader behavior, which will reject it after the strong hashes.
        return true;
    };
    let Ok(candidate) = serde_json::from_slice::<serde_json::Value>(&candidate_bytes) else {
        return true;
    };
    let Some(identity) = candidate
        .get("lanes")
        .and_then(|lanes| lanes.get("ck").and_then(|ck| ck.get("identity")))
    else {
        return true;
    };
    let Some(toolchain_content) = toolchain_content_sha256(toolchain_key) else {
        return true;
    };
    let expected = [
        ("fqbn", canonical_fqbn),
        ("coreVersion", core_version),
        ("cliVersion", cli_version),
        ("toolchainKey", toolchain_key),
        ("toolchainContentSha256", toolchain_content),
        ("hostIdentitySha256", host_identity_sha256),
        ("sketchSha256", sketch_sha256),
    ];
    for (field, value) in expected {
        let Some(actual) = json_string(identity, field) else {
            // Older/partial candidates lack enough request-side data to prove
            // a mismatch. Keep them on the original full-validation path.
            return true;
        };
        if actual != value {
            return false;
        }
    }
    true
}

/// Inspect only bounded JSON metadata to determine whether a NativeRelink
/// directory can possibly match this exact request. The full loader still
/// canonicalizes the qualification-key directory, hashes the CLI/evidence,
/// recomputes every A/B gate and validates the running executable before it
/// grants access. Consequently a forged hint can only cause extra work, never
/// enable the fast lane.
fn may_contain_native_relink_target(
    directory: &std::path::Path,
    fqbn: &str,
    core_version: &str,
    cli_version: &str,
    toolchain_key: &str,
    adapter: &NativeRelinkAdapterDescriptor,
) -> bool {
    let Some(certificate_bytes) = read_bounded_file(
        &directory.join("certificate.json"),
        MAX_QUALIFICATION_CERTIFICATE_BYTES,
    ) else {
        return false;
    };
    let Ok(certificate) =
        serde_json::from_slice::<LocalNativeRelinkCertificate>(&certificate_bytes)
    else {
        return false;
    };
    if certificate.schema_id != LOCAL_QUALIFICATION_SCHEMA_ID
        || certificate.schema_version != 4
        || certificate.candidate_profile != NATIVE_RELINK_PROFILE_ID
    {
        return false;
    }
    let Some(report_bytes) =
        read_bounded_file(&directory.join("report.json"), MAX_QUALIFICATION_JSON_BYTES)
    else {
        return false;
    };
    let Ok(report) = serde_json::from_slice::<serde_json::Value>(&report_bytes) else {
        return false;
    };
    let Some(target) = report.get("target") else {
        return false;
    };
    let Some(policy) = report.get("policy") else {
        return false;
    };
    json_string(&report, "schemaId") == Some(NATIVE_RELINK_REPORT_SCHEMA_ID)
        && json_string(&report, "operation") == Some("compile")
        && json_string(&report, "candidateProfile") == Some(NATIVE_RELINK_PROFILE_ID)
        && json_string(policy, "id") == Some(NATIVE_RELINK_POLICY_ID)
        && json_string(&report, "nativeRelinkAdapterId") == Some(adapter.id)
        && json_string(&report, "nativeRelinkContractId") == Some(adapter.engine_contract_id)
        && json_string(&report, "artifactEquivalencePolicyId") == Some(adapter.artifact_policy_id)
        && json_string(target, "fqbn") == Some(fqbn)
        && json_string(target, "coreVersion") == Some(core_version)
        && json_string(target, "cliVersion") == Some(cli_version)
        && json_string(target, "toolchainKey") == Some(toolchain_key)
}

/// Extract a denial-only lookup hint from one qualification directory.  This
/// never grants NativeRelink access: the selected directory is still opened,
/// hashed and fully recomputed by `load_native_relink_evidence_sha256_from_root`.
/// Keeping this small index in process avoids reopening hundreds of unrelated
/// certificate/report pairs on every foreground compile.
fn native_relink_hint_from_directory(directory: &std::path::Path) -> Option<NativeRelinkHintKey> {
    let certificate_bytes = read_bounded_file(
        &directory.join("certificate.json"),
        MAX_QUALIFICATION_CERTIFICATE_BYTES,
    )?;
    let certificate =
        serde_json::from_slice::<LocalNativeRelinkCertificate>(&certificate_bytes).ok()?;
    if certificate.schema_id != LOCAL_QUALIFICATION_SCHEMA_ID
        || certificate.schema_version != 4
        || certificate.candidate_profile != NATIVE_RELINK_PROFILE_ID
    {
        return None;
    }
    let report_bytes =
        read_bounded_file(&directory.join("report.json"), MAX_QUALIFICATION_JSON_BYTES)?;
    let report = serde_json::from_slice::<serde_json::Value>(&report_bytes).ok()?;
    let target = report.get("target")?;
    let policy = report.get("policy")?;
    let fqbn = json_string(&report, "schemaId")
        .filter(|schema| *schema == NATIVE_RELINK_REPORT_SCHEMA_ID)
        .and_then(|_| json_string(&report, "operation"))
        .filter(|operation| *operation == "compile")
        .and_then(|_| json_string(&report, "candidateProfile"))
        .filter(|profile| *profile == NATIVE_RELINK_PROFILE_ID)
        .and_then(|_| json_string(target, "fqbn"))?;
    let adapter = native_relink_adapter_for(fqbn, None)?;
    if json_string(policy, "id") != Some(NATIVE_RELINK_POLICY_ID)
        || json_string(&report, "nativeRelinkAdapterId") != Some(adapter.id)
        || json_string(&report, "nativeRelinkContractId") != Some(adapter.engine_contract_id)
        || json_string(&report, "artifactEquivalencePolicyId") != Some(adapter.artifact_policy_id)
    {
        return None;
    }
    Some(NativeRelinkHintKey {
        fqbn: fqbn.to_owned(),
        core_version: json_string(target, "coreVersion")?.to_owned(),
        cli_version: json_string(target, "cliVersion")?.to_owned(),
        toolchain_key: json_string(target, "toolchainKey")?.to_owned(),
        adapter_id: adapter.id.to_owned(),
    })
}

const MAX_NATIVE_RELINK_HINT_INDEX_ENTRIES: usize = 1_024;

fn ensure_native_relink_root_hint_index(
    root: &std::path::Path,
    canonical_root: &std::path::Path,
) -> bool {
    let metadata = match std::fs::symlink_metadata(root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => metadata,
        _ => return false,
    };
    let root_modified = metadata.modified().ok();
    if native_relink_hint_indexes()
        .lock()
        .ok()
        .and_then(|indexes| {
            indexes
                .get(canonical_root)
                .map(|index| index.root_modified == root_modified)
        })
        .unwrap_or(false)
    {
        return true;
    }

    let mut entries = HashMap::<NativeRelinkHintKey, Vec<PathBuf>>::new();
    let mut count = 0_usize;
    let Ok(children) = std::fs::read_dir(root) else {
        return false;
    };
    for child in children {
        count = count.saturating_add(1);
        if count > MAX_NATIVE_RELINK_HINT_INDEX_ENTRIES {
            if let Ok(mut indexes) = native_relink_hint_indexes().lock() {
                indexes.insert(
                    canonical_root.to_path_buf(),
                    NativeRelinkRootHintIndex {
                        root_modified,
                        entries: HashMap::new(),
                        complete: false,
                    },
                );
            }
            return false;
        }
        let Ok(child) = child else {
            continue;
        };
        if !child.file_type().ok().is_some_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(canonical) = child.path().canonicalize() else {
            continue;
        };
        if canonical.parent() != Some(canonical_root) {
            continue;
        }
        if let Some(key) = native_relink_hint_from_directory(&canonical) {
            entries.entry(key).or_default().push(canonical);
        }
    }
    let Ok(mut indexes) = native_relink_hint_indexes().lock() else {
        return false;
    };
    indexes.insert(
        canonical_root.to_path_buf(),
        NativeRelinkRootHintIndex {
            root_modified,
            entries,
            complete: true,
        },
    );
    true
}

fn indexed_native_relink_target_directory(
    root: &std::path::Path,
    canonical_root: &std::path::Path,
    fqbn: &str,
    core_version: &str,
    cli_version: &str,
    toolchain_key: &str,
    adapter: &NativeRelinkAdapterDescriptor,
) -> Option<std::path::PathBuf> {
    let root_modified = std::fs::symlink_metadata(root).ok()?.modified().ok();
    let Ok(indexes) = native_relink_hint_indexes().lock() else {
        return None;
    };
    let index = indexes.get(canonical_root)?;
    if index.root_modified != root_modified || !index.complete {
        return None;
    }
    let key = NativeRelinkHintKey {
        fqbn: fqbn.to_owned(),
        core_version: core_version.to_owned(),
        cli_version: cli_version.to_owned(),
        toolchain_key: toolchain_key.to_owned(),
        adapter_id: adapter.id.to_owned(),
    };
    let candidates = index.entries.get(&key)?.clone();
    drop(indexes);
    candidates.into_iter().find(|candidate| {
        candidate.canonicalize().ok().is_some_and(|canonical| {
            canonical == *candidate && canonical.parent() == Some(canonical_root)
        }) && may_contain_native_relink_target(
            candidate,
            fqbn,
            core_version,
            cli_version,
            toolchain_key,
            adapter,
        )
    })
}

fn native_relink_hint_index_is_complete(
    root: &std::path::Path,
    canonical_root: &std::path::Path,
) -> bool {
    let root_modified = std::fs::symlink_metadata(root)
        .ok()
        .and_then(|metadata| metadata.modified().ok());
    native_relink_hint_indexes()
        .lock()
        .ok()
        .and_then(|indexes| {
            indexes
                .get(canonical_root)
                .map(|index| index.complete && index.root_modified == root_modified)
        })
        .unwrap_or(false)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeRelinkHintScan {
    ExactTargetPresent,
    CompleteNoMatch,
    BudgetExceeded,
}

/// Count sibling entries before opening any certificate/report. A complete
/// small-store miss avoids the expensive CLI hash; an over-budget store goes
/// straight to exact-key lookup without parsing up to 64 unrelated evidence
/// pairs on every compile. This remains a denial-only hint: concurrent store
/// changes can at worst defer use of a valid certificate until the next call.
fn scan_native_relink_hints_with_budget(
    root: &std::path::Path,
    canonical_root: &std::path::Path,
    fqbn: &str,
    core_version: &str,
    cli_version: &str,
    toolchain_key: &str,
    adapter: &NativeRelinkAdapterDescriptor,
    max_entries: usize,
) -> Option<NativeRelinkHintScan> {
    if indexed_native_relink_target_directory(
        root,
        canonical_root,
        fqbn,
        core_version,
        cli_version,
        toolchain_key,
        adapter,
    )
    .is_some()
    {
        return Some(NativeRelinkHintScan::ExactTargetPresent);
    }
    if native_relink_hint_index_is_complete(root, canonical_root) {
        return Some(NativeRelinkHintScan::CompleteNoMatch);
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(root).ok()? {
        entries.push(entry);
        if entries.len() > max_entries {
            return Some(NativeRelinkHintScan::BudgetExceeded);
        }
    }
    for entry in entries {
        let Ok(entry) = entry else {
            // An unreadable sibling is never a positive authorization hint.
            continue;
        };
        if !entry.file_type().ok().is_some_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(canonical) = entry.path().canonicalize() else {
            continue;
        };
        if canonical.parent() != Some(canonical_root) {
            continue;
        }
        if may_contain_native_relink_target(
            &canonical,
            fqbn,
            core_version,
            cli_version,
            toolchain_key,
            adapter,
        ) {
            return Some(NativeRelinkHintScan::ExactTargetPresent);
        }
    }
    Some(NativeRelinkHintScan::CompleteNoMatch)
}

fn scan_native_relink_hints(
    root: &std::path::Path,
    canonical_root: &std::path::Path,
    fqbn: &str,
    core_version: &str,
    cli_version: &str,
    toolchain_key: &str,
    adapter: &NativeRelinkAdapterDescriptor,
) -> Option<NativeRelinkHintScan> {
    scan_native_relink_hints_with_budget(
        root,
        canonical_root,
        fqbn,
        core_version,
        cli_version,
        toolchain_key,
        adapter,
        MAX_LOCAL_QUALIFICATION_HINT_SCAN,
    )
}

/// Find an authenticated NativeRelink certificate for the exact target when
/// its directory was created by an earlier desktop rebuild.  The executable
/// hash is retained as provenance inside the evidence, but it is not the
/// compiler-engine identity: the versioned CK Forge contract is.  This
/// bounded metadata scan is only reached after the current executable-key
/// lookup misses; the full loader still re-hashes and re-validates every file
/// before granting access.
fn find_native_relink_target_directory_with_budget(
    root: &std::path::Path,
    canonical_root: &std::path::Path,
    fqbn: &str,
    core_version: &str,
    cli_version: &str,
    toolchain_key: &str,
    adapter: &NativeRelinkAdapterDescriptor,
    max_probes: usize,
) -> Option<std::path::PathBuf> {
    if let Some(candidate) = indexed_native_relink_target_directory(
        root,
        canonical_root,
        fqbn,
        core_version,
        cli_version,
        toolchain_key,
        adapter,
    ) {
        return Some(candidate);
    }
    if native_relink_hint_index_is_complete(root, canonical_root) {
        return None;
    }
    let mut probes = 0_usize;
    for entry in std::fs::read_dir(root).ok()? {
        probes = probes.saturating_add(1);
        if probes > max_probes {
            return None;
        }
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.file_type().ok().is_some_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(canonical) = entry.path().canonicalize() else {
            continue;
        };
        if canonical.parent() != Some(canonical_root) {
            continue;
        }
        if may_contain_native_relink_target(
            &canonical,
            fqbn,
            core_version,
            cli_version,
            toolchain_key,
            adapter,
        ) {
            return Some(canonical);
        }
    }
    None
}

fn find_native_relink_target_directory(
    root: &std::path::Path,
    canonical_root: &std::path::Path,
    fqbn: &str,
    core_version: &str,
    cli_version: &str,
    toolchain_key: &str,
    adapter: &NativeRelinkAdapterDescriptor,
) -> Option<std::path::PathBuf> {
    find_native_relink_target_directory_with_budget(
        root,
        canonical_root,
        fqbn,
        core_version,
        cli_version,
        toolchain_key,
        adapter,
        MAX_LOCAL_PERFORMANCE_DIRECTORY_PROBES,
    )
}

/// Resolve a qualification by its authenticated key without trusting or
/// walking sibling entries. Symlinks, junction escapes, nested paths, and
/// malformed names fail closed.
fn exact_local_qualification_directory(
    root: &std::path::Path,
    canonical_root: &std::path::Path,
    qualification_key: &str,
) -> Option<std::path::PathBuf> {
    if !sha256_text_is_valid(qualification_key) {
        return None;
    }
    let requested = root.join(qualification_key);
    let metadata = std::fs::symlink_metadata(&requested).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    let canonical = requested.canonicalize().ok()?;
    (canonical.parent() == Some(canonical_root)
        && canonical.file_name()?.to_str()? == qualification_key)
        .then_some(canonical)
}

fn json_true(value: &serde_json::Value, key: &str) -> bool {
    value.get(key).and_then(serde_json::Value::as_bool) == Some(true)
}

fn validated_operation_profile(
    candidate: &serde_json::Value,
) -> Option<(ForgePerformanceOperation, ForgePerformanceProfile)> {
    let operation = serde_json::from_value(candidate.get("operation")?.clone()).ok()?;
    let profile = serde_json::from_value(candidate.get("candidateProfile")?.clone()).ok()?;
    supported_performance_operation_profile(operation, profile).then_some((operation, profile))
}

fn safe_core_identity_component(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && value.len() <= 128
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '+' | '-')
        })
}

/// The only PortableFast artifact exception is deliberately tied to a literal
/// ESP32 Core recipe.  An absent proof means the generic exact policy; a
/// malformed or misbound proof rejects the candidate instead of quietly
/// falling back to a broader policy.
fn portable_fast_esp_application_recipe_proof_state(candidate: &serde_json::Value) -> Option<bool> {
    let Some(proof) = candidate.get("portableFastEspApplicationBinRecipeProof") else {
        return Some(false);
    };
    let proof_fields = proof.as_object()?;
    if proof_fields.len() != 11
        || ![
            "schemaVersion",
            "kind",
            "corePackage",
            "coreArchitecture",
            "coreVersion",
            "recipeProperty",
            "recipeSource",
            "recipeSourceSha256",
            "recipeValueSha256",
            "elfSha256OffsetArgument",
            "elfSha256Offset",
        ]
        .iter()
        .all(|field| proof_fields.contains_key(*field))
        || proof.get("schemaVersion")?.as_u64()
            != Some(ESP_APPLICATION_BIN_RECIPE_PROOF_SCHEMA_VERSION)
        || json_raw_string(proof, "kind") != Some(ESP_APPLICATION_BIN_RECIPE_PROOF_KIND)
        || json_raw_string(proof, "recipeProperty") != Some(ESP_APPLICATION_BIN_RECIPE_PROPERTY)
        || !matches!(
            json_raw_string(proof, "recipeSource"),
            Some("platform.txt" | "platform.local.txt")
        )
        || !json_raw_string(proof, "corePackage").is_some_and(safe_core_identity_component)
        || json_raw_string(proof, "coreArchitecture") != Some("esp32")
        || !json_raw_string(proof, "coreVersion").is_some_and(safe_core_identity_component)
        || !json_raw_string(proof, "recipeSourceSha256").is_some_and(sha256_text_is_valid)
        || !json_raw_string(proof, "recipeValueSha256").is_some_and(sha256_text_is_valid)
        || json_raw_string(proof, "elfSha256OffsetArgument")
            != Some(ESP_APPLICATION_BIN_ELF_SHA256_ARGUMENT)
        || proof.get("elfSha256Offset")?.as_u64() != Some(ESP_APPLICATION_BIN_ELF_SHA256_OFFSET)
    {
        return None;
    }
    let identity = candidate.get("lanes")?.get("ck")?.get("identity")?;
    (json_raw_string(proof, "corePackage") == json_raw_string(identity, "corePackage")
        && json_raw_string(proof, "coreArchitecture")
            == json_raw_string(identity, "coreArchitecture")
        && json_raw_string(proof, "coreVersion") == json_raw_string(identity, "coreVersion"))
    .then_some(true)
}

fn fast_artifact_equivalence_policy_id(
    candidate: &serde_json::Value,
    operation: ForgePerformanceOperation,
    profile: ForgePerformanceProfile,
) -> Option<&'static str> {
    if candidate
        .get("portableFastEspApplicationBinRecipeProof")
        .is_some()
        && profile != ForgePerformanceProfile::PortableFast
    {
        return None;
    }
    match (operation, profile) {
        (ForgePerformanceOperation::Compile, ForgePerformanceProfile::PortableFast) => {
            match portable_fast_esp_application_recipe_proof_state(candidate)? {
                true => Some(PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID),
                false => Some(GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID),
            }
        }
        (ForgePerformanceOperation::Compile, ForgePerformanceProfile::QuickFast) => {
            Some(COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID)
        }
        (ForgePerformanceOperation::UploadReady, ForgePerformanceProfile::QuickFast)
        | (ForgePerformanceOperation::UploadReady, ForgePerformanceProfile::SharedFast) => {
            Some(GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID)
        }
        _ => None,
    }
}

fn controls_are_qualification_safe(controls: &serde_json::Value) -> bool {
    [
        "compileOnly",
        "sameMachine",
        "freshBuildPathsVerified",
        "sameBuildPathWithinLaneVerified",
        "stageSourceHashesVerified",
        "exactReuseDenied",
        "routeGatePassed",
        "recipeCapabilityGatePassed",
        "globalCachesSharedEqually",
        "noConcurrentCompiles",
        "laneBoundaryIdleGatePassed",
        "compilePropertyDeltaDeclared",
        "dependencyClosureGatePassed",
        "artifactGatePassed",
        "resourceGatePassed",
    ]
    .iter()
    .all(|field| json_true(controls, field))
        && [
            "uploadPerformed",
            "physicalFlashWritten",
            "serialPortAccessed",
        ]
        .iter()
        .all(|field| controls.get(field).and_then(serde_json::Value::as_bool) == Some(false))
}

type ArtifactContentMultiset = std::collections::BTreeMap<(u64, String), usize>;

fn candidate_artifact_content_multiset(run: &serde_json::Value) -> Option<ArtifactContentMultiset> {
    let artifacts = run.get("artifacts")?.as_array()?;
    if artifacts.is_empty() || artifacts.len() > MAX_QUALIFICATION_ARTIFACTS {
        return None;
    }
    let mut identities = ArtifactContentMultiset::new();
    for artifact in artifacts {
        let size = artifact.get("bytes")?.as_u64()?;
        let digest = json_string(artifact, "sha256")?;
        if size == 0 || !sha256_text_is_valid(digest) {
            return None;
        }
        *identities.entry((size, digest.to_string())).or_insert(0) += 1;
    }
    Some(identities)
}

fn validate_artifact_set(
    qualification_dir: &std::path::Path,
    manifest_bytes: &[u8],
) -> Option<(String, ArtifactContentMultiset)> {
    let manifest = serde_json::from_slice::<LocalArtifactSetManifest>(manifest_bytes).ok()?;
    if manifest.schema_id != LOCAL_ARTIFACT_SET_SCHEMA_ID
        || manifest.schema_version != 1
        || manifest.artifacts.is_empty()
        || manifest.artifacts.len() > MAX_QUALIFICATION_ARTIFACTS
    {
        return None;
    }
    let canonical_root = qualification_dir.canonicalize().ok()?;
    let mut seen = std::collections::BTreeSet::new();
    let mut identities = ArtifactContentMultiset::new();
    let mut total = 0_u64;
    for artifact in manifest.artifacts {
        if artifact.path.trim().is_empty()
            || artifact.path.contains('\\')
            || !sha256_text_is_valid(&artifact.sha256)
        {
            return None;
        }
        let artifact_path = artifact.path.clone();
        let relative = std::path::Path::new(&artifact_path);
        if relative.is_absolute()
            || relative.components().any(|component| {
                !matches!(
                    component,
                    std::path::Component::Normal(_) | std::path::Component::CurDir
                )
            })
            || !seen.insert(artifact_path.clone())
        {
            return None;
        }
        let path = qualification_dir.join(relative);
        let canonical = path.canonicalize().ok()?;
        if !canonical.starts_with(&canonical_root) {
            return None;
        }
        let bytes = read_bounded_file(&canonical, MAX_QUALIFICATION_ARTIFACT_BYTES)?;
        if bytes.len() as u64 != artifact.size || sha256_bytes(&bytes) != artifact.sha256 {
            return None;
        }
        *identities
            .entry((artifact.size, artifact.sha256.clone()))
            .or_insert(0) += 1;
        total = total.checked_add(artifact.size)?;
        if total > MAX_QUALIFICATION_ARTIFACT_SET_BYTES {
            return None;
        }
    }
    Some((sha256_bytes(manifest_bytes), identities))
}

fn lane_trials<'a>(
    candidate: &'a serde_json::Value,
    lane: &str,
) -> Option<&'a Vec<serde_json::Value>> {
    candidate.get("lanes")?.get(lane)?.get("trials")?.as_array()
}

fn run_wall_ms(run: &serde_json::Value) -> Option<u64> {
    if !json_true(run, "success")
        || !json_true(run, "artifactsVerified")
        || !json_true(run, "resourceGatePassed")
        || run.get("exactUsed")?.as_bool() != Some(false)
        || !sha256_text_is_valid(json_string(run, "artifactSetSha256")?)
        || !sha256_text_is_valid(json_string(run, "evidenceSha256")?)
        || !sha256_text_is_valid(json_string(run, "codeSha256")?)
        || !sha256_text_is_valid(json_string(run, "buildPathIdentitySha256")?)
    {
        return None;
    }
    let resources = run.get("resources")?;
    if !json_true(resources, "evidenceComplete")
        || resources.get("flashUsedBytes")?.as_u64().is_none()
        || resources.get("ramUsedBytes")?.as_u64().is_none()
        || resources.get("warningCount")?.as_u64().is_none()
    {
        return None;
    }
    run.get("wallMs")?.as_u64().filter(|value| *value > 0)
}

fn median_bounds(mut values: Vec<u64>) -> Option<(u64, u64)> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let middle = values.len() / 2;
    if values.len() % 2 == 1 {
        Some((values[middle], values[middle]))
    } else {
        let sum = values[middle - 1].checked_add(values[middle])?;
        Some((sum / 2, sum.saturating_add(1) / 2))
    }
}

fn p95(mut values: Vec<u64>) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let rank = (95_usize.checked_mul(values.len())?.saturating_add(99)) / 100;
    values.get(rank.saturating_sub(1)).copied()
}

fn cv_basis_points(values: &[u64]) -> Option<u32> {
    if values.is_empty() {
        return None;
    }
    let count = values.len() as f64;
    let mean = values.iter().map(|value| *value as f64).sum::<f64>() / count;
    if !mean.is_finite() || mean <= 0.0 {
        return None;
    }
    let variance = values
        .iter()
        .map(|value| {
            let delta = *value as f64 - mean;
            delta * delta
        })
        .sum::<f64>()
        / count;
    let basis_points = ((variance.sqrt() / mean) * 10_000.0).ceil();
    (basis_points.is_finite() && basis_points >= 0.0 && basis_points <= u32::MAX as f64)
        .then_some(basis_points as u32)
}

fn candidate_stage_values(
    candidate: &serde_json::Value,
    lane: &str,
    stage: &str,
) -> Option<Vec<u64>> {
    lane_trials(candidate, lane)?
        .iter()
        .map(|trial| run_wall_ms(trial.get(stage)?))
        .collect()
}

fn portable_edit_sequence_is_valid(candidate: &serde_json::Value) -> bool {
    let Some(stages) = candidate
        .get("stages")
        .and_then(serde_json::Value::as_array)
    else {
        return false;
    };
    if stages.len() != PORTABLE_EDIT_STAGES.len()
        || json_string(candidate, "measurementSequence") != Some(PERFORMANCE_MEASUREMENT_SEQUENCE)
    {
        return false;
    }
    if !stages
        .iter()
        .zip(PORTABLE_EDIT_STAGES)
        .all(|(stage, (expected_id, expected_sha256))| {
            json_string(stage, "id") == Some(expected_id)
                && json_string(stage, "sourceSha256") == Some(expected_sha256)
                && stage.as_object().is_some_and(|object| object.len() == 2)
        })
    {
        return false;
    }
    let Some(sequence_sha256) = json_string(candidate, "sequenceSha256") else {
        return false;
    };
    sha256_text_is_valid(sequence_sha256)
        && sha256_bytes(canonical_json(candidate.get("stages").unwrap()).as_bytes())
            == sequence_sha256
}

fn run_resources(run: &serde_json::Value) -> Option<(u64, u64, u64)> {
    let resources = run.get("resources")?;
    json_true(resources, "evidenceComplete").then_some((
        resources.get("flashUsedBytes")?.as_u64()?,
        resources.get("ramUsedBytes")?.as_u64()?,
        resources.get("warningCount")?.as_u64()?,
    ))
}

fn run_artifacts_by_role(
    run: &serde_json::Value,
) -> Option<std::collections::BTreeMap<String, (u64, String, bool)>> {
    let artifacts = run.get("artifacts")?.as_array()?;
    if artifacts.is_empty() || artifacts.len() > MAX_QUALIFICATION_ARTIFACTS {
        return None;
    }
    let mut by_role = std::collections::BTreeMap::new();
    let mut has_primary = false;
    for artifact in artifacts {
        let name = json_string(artifact, "name")?;
        let role = json_string(artifact, "role")?;
        let bytes = artifact.get("bytes")?.as_u64()?;
        let sha256 = json_string(artifact, "sha256")?;
        let primary = artifact.get("primaryApplication")?.as_bool()?;
        if name.trim().is_empty()
            || role.trim().is_empty()
            || bytes == 0
            || !sha256_text_is_valid(sha256)
            || by_role
                .insert(role.to_string(), (bytes, sha256.to_string(), primary))
                .is_some()
        {
            return None;
        }
        has_primary |= primary;
    }
    has_primary.then_some(by_role)
}

/// Hash only the portable artifact identity. Optional proof fields are bound
/// by the candidate/report payload, but deliberately do not change the
/// historical artifact-set digest used by existing certificates.
fn artifact_integrity_projection(artifacts: &serde_json::Value) -> Option<serde_json::Value> {
    let artifacts = artifacts.as_array()?;
    if artifacts.is_empty() || artifacts.len() > MAX_QUALIFICATION_ARTIFACTS {
        return None;
    }
    let mut projected = Vec::with_capacity(artifacts.len());
    for artifact in artifacts {
        let artifact = artifact.as_object()?;
        let mut identity = serde_json::Map::new();
        for field in ["name", "bytes", "sha256", "primaryApplication", "role"] {
            identity.insert(field.to_string(), artifact.get(field)?.clone());
        }
        projected.push(serde_json::Value::Object(identity));
    }
    Some(serde_json::Value::Array(projected))
}

fn run_artifact_set_is_bound(run: &serde_json::Value) -> bool {
    let Some(artifacts) = run.get("artifacts").and_then(artifact_integrity_projection) else {
        return false;
    };
    json_string(run, "artifactSetSha256").is_some_and(|expected| {
        sha256_text_is_valid(expected)
            && sha256_bytes(canonical_json(&artifacts).as_bytes()) == expected
    })
}

fn generic_run_artifacts_equivalent(
    ck_run: &serde_json::Value,
    native_run: &serde_json::Value,
) -> bool {
    run_artifact_set_is_bound(ck_run)
        && run_artifact_set_is_bound(native_run)
        && matches!(
            (
                run_artifacts_by_role(ck_run),
                run_artifacts_by_role(native_run)
            ),
            (Some(ck), Some(native)) if ck == native
        )
}

fn run_unique_artifact_for_role<'a>(
    run: &'a serde_json::Value,
    role: &str,
) -> Option<&'a serde_json::Value> {
    let artifacts = run.get("artifacts")?.as_array()?;
    let mut matching = artifacts
        .iter()
        .filter(|artifact| json_string(artifact, "role") == Some(role));
    let artifact = matching.next()?;
    matching.next().is_none().then_some(artifact)
}

/// Return the two immutable ranges for the only PortableFast artifact
/// exception.  The embedded ELF digest (0xb0..0xcf) and the final ESP image
/// checksum/SHA footer may differ; every other application byte is bound by
/// matching segment hashes.  Any unfamiliar witness layout is rejected.
fn esp_application_bin_immutable_segment_hashes(
    artifact: &serde_json::Value,
    byte_length: u64,
) -> Option<(String, String)> {
    let minimum_length = ESP_APPLICATION_BIN_ELF_SHA256_OFFSET
        .checked_add(ESP_APPLICATION_BIN_ELF_SHA256_LENGTH)?
        .checked_add(ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH)?;
    if byte_length < minimum_length {
        return None;
    }
    let witness = artifact.get("payloadEquivalenceWitness")?;
    let witness_fields = witness.as_object()?;
    if witness_fields.len() != 7
        || ![
            "schemaVersion",
            "kind",
            "recipe",
            "byteLength",
            "mutableRange",
            "immutableSegments",
            "footer",
        ]
        .iter()
        .all(|field| witness_fields.contains_key(*field))
        || witness.get("schemaVersion")?.as_u64()
            != Some(ESP_APPLICATION_BIN_PAYLOAD_WITNESS_SCHEMA_VERSION)
        || json_string(witness, "kind") != Some(ESP_APPLICATION_BIN_PAYLOAD_WITNESS_KIND)
        || witness.get("byteLength")?.as_u64() != Some(byte_length)
    {
        return None;
    }

    let recipe = witness.get("recipe")?;
    let recipe_fields = recipe.as_object()?;
    if recipe_fields.len() != 2
        || !["elfSha256OffsetArgument", "elfSha256Offset"]
            .iter()
            .all(|field| recipe_fields.contains_key(*field))
        || json_string(recipe, "elfSha256OffsetArgument")
            != Some(ESP_APPLICATION_BIN_ELF_SHA256_ARGUMENT)
        || recipe.get("elfSha256Offset")?.as_u64() != Some(ESP_APPLICATION_BIN_ELF_SHA256_OFFSET)
    {
        return None;
    }

    let mutable_range = witness.get("mutableRange")?;
    let mutable_fields = mutable_range.as_object()?;
    if mutable_fields.len() != 2
        || !["offset", "length"]
            .iter()
            .all(|field| mutable_fields.contains_key(*field))
        || mutable_range.get("offset")?.as_u64() != Some(ESP_APPLICATION_BIN_ELF_SHA256_OFFSET)
        || mutable_range.get("length")?.as_u64() != Some(ESP_APPLICATION_BIN_ELF_SHA256_LENGTH)
    {
        return None;
    }

    let footer_offset = byte_length.checked_sub(ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH)?;
    let footer = witness.get("footer")?;
    let footer_fields = footer.as_object()?;
    if footer_fields.len() != 7
        || ![
            "offset",
            "length",
            "checksumOffset",
            "checksum",
            "validationHash",
            "checksumValid",
            "validationHashValid",
        ]
        .iter()
        .all(|field| footer_fields.contains_key(*field))
        || footer.get("offset")?.as_u64() != Some(footer_offset)
        || footer.get("length")?.as_u64() != Some(ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH)
        || footer.get("checksumOffset")?.as_u64() != Some(footer_offset)
        || !footer
            .get("checksum")?
            .as_u64()
            .is_some_and(|value| value <= u8::MAX as u64)
        || !json_string(footer, "validationHash").is_some_and(sha256_text_is_valid)
        || !json_true(footer, "checksumValid")
        || !json_true(footer, "validationHashValid")
    {
        return None;
    }

    let mutable_end =
        ESP_APPLICATION_BIN_ELF_SHA256_OFFSET.checked_add(ESP_APPLICATION_BIN_ELF_SHA256_LENGTH)?;
    let expected_segments = [
        (0, ESP_APPLICATION_BIN_ELF_SHA256_OFFSET),
        (mutable_end, footer_offset.checked_sub(mutable_end)?),
    ];
    let segments = witness.get("immutableSegments")?.as_array()?;
    if segments.len() != expected_segments.len() {
        return None;
    }
    let mut hashes = Vec::with_capacity(segments.len());
    for (segment, (offset, length)) in segments.iter().zip(expected_segments) {
        let fields = segment.as_object()?;
        let sha256 = json_string(segment, "sha256")?;
        if fields.len() != 3
            || !["offset", "length", "sha256"]
                .iter()
                .all(|field| fields.contains_key(*field))
            || segment.get("offset")?.as_u64() != Some(offset)
            || segment.get("length")?.as_u64() != Some(length)
            || !sha256_text_is_valid(sha256)
        {
            return None;
        }
        hashes.push(sha256.to_string());
    }
    let [prefix, body] = hashes.try_into().ok()?;
    Some((prefix, body))
}

/// One normalized `flash_args` segment: `payload` carries `(bytes, sha256)`
/// when the referenced file was materialized in the build path, and `None`
/// when the reference is a Core-package constant flashed straight from the
/// shared installation (e.g. `boot_app0.bin`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct EspFlashArgsSegment {
    offset: u64,
    role: String,
    reference: String,
    payload: Option<(u64, String)>,
}

/// Validate a normalized `flash_args` witness and return its comparable
/// projection: the exact flash option lines plus every offset/role/reference
/// segment. Any unfamiliar witness layout is rejected.
fn esp_flash_args_normalized_witness(
    artifact: &serde_json::Value,
    byte_length: u64,
) -> Option<(Vec<String>, Vec<EspFlashArgsSegment>)> {
    if byte_length == 0 {
        return None;
    }
    let witness = artifact.get("flashArgumentsWitness")?;
    let witness_fields = witness.as_object()?;
    if witness_fields.len() != 5
        || ![
            "schemaVersion",
            "kind",
            "byteLength",
            "optionLines",
            "segments",
        ]
        .iter()
        .all(|field| witness_fields.contains_key(*field))
        || witness.get("schemaVersion")?.as_u64() != Some(ESP_FLASH_ARGS_WITNESS_SCHEMA_VERSION)
        || json_string(witness, "kind") != Some(ESP_FLASH_ARGS_WITNESS_KIND)
        || witness.get("byteLength")?.as_u64() != Some(byte_length)
    {
        return None;
    }
    let option_lines = witness
        .get("optionLines")?
        .as_array()?
        .iter()
        .map(|line| line.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()?;
    if option_lines.iter().any(String::is_empty) {
        return None;
    }
    let raw_segments = witness.get("segments")?.as_array()?;
    if raw_segments.is_empty() {
        return None;
    }
    let mut offsets = std::collections::BTreeSet::new();
    let mut segments = Vec::with_capacity(raw_segments.len());
    for segment in raw_segments {
        let fields = segment.as_object()?;
        let offset = segment.get("offset")?.as_u64()?;
        let role = json_string(segment, "role")?;
        let reference = json_string(segment, "reference")?;
        let resolved = segment.get("resolved")?.as_bool()?;
        if role.trim().is_empty()
            || reference.trim().is_empty()
            || reference.contains('/')
            || reference.contains('\\')
            || reference == "."
            || reference == ".."
            || !offsets.insert(offset)
        {
            return None;
        }
        let payload = if resolved {
            let bytes = segment.get("bytes")?.as_u64()?;
            let sha256 = json_string(segment, "sha256")?;
            if fields.len() != 6
                || !["offset", "role", "reference", "resolved", "bytes", "sha256"]
                    .iter()
                    .all(|field| fields.contains_key(*field))
                || bytes == 0
                || !sha256_text_is_valid(sha256)
            {
                return None;
            }
            Some((bytes, sha256.to_string()))
        } else {
            if fields.len() != 4
                || !["offset", "role", "reference", "resolved"]
                    .iter()
                    .all(|field| fields.contains_key(*field))
            {
                return None;
            }
            None
        };
        segments.push(EspFlashArgsSegment {
            offset,
            role: role.to_string(),
            reference: reference.to_string(),
            payload,
        });
    }
    Some((option_lines, segments))
}

/// PortableFast normally uses generic full artifact equality. Compile-only
/// byproducts (`application-elf`, `merged-firmware-bin`) stay count-symmetric
/// and CK's provenance `upload-manifest` may only exist on the CK lane; none
/// of them are flash payloads. Two content exceptions remain, both witness
/// proven: the ESP32 application image may differ only inside the
/// recipe-proven embedded ELF SHA-256 window plus its validated footer, and
/// `flash_args` may differ only in the lane-local file names it references —
/// its normalized witness must prove identical flash options, identical
/// offset/role/size layout, and per-offset payloads that are byte-identical
/// across lanes (or exactly the validated application image). Every other
/// retained role remains byte-exact.
fn portable_fast_run_artifacts_equivalent(
    ck_run: &serde_json::Value,
    native_run: &serde_json::Value,
) -> bool {
    if generic_run_artifacts_equivalent(ck_run, native_run) {
        return true;
    }
    if !run_artifact_set_is_bound(ck_run) || !run_artifact_set_is_bound(native_run) {
        return false;
    }
    let Some(mut ck) = run_artifacts_by_role(ck_run) else {
        return false;
    };
    let Some(mut native) = run_artifacts_by_role(native_run) else {
        return false;
    };
    for role in PORTABLE_FAST_COMPILE_ONLY_EXCLUDED_ARTIFACT_ROLES {
        let ck_present = ck.remove(role).is_some();
        let native_present = native.remove(role).is_some();
        let count_valid = if role == "upload-manifest" {
            !native_present
        } else {
            ck_present == native_present
        };
        if !count_valid {
            return false;
        }
    }
    if ck.keys().ne(native.keys()) {
        return false;
    }
    for (role, artifact) in &ck {
        let Some(native_artifact) = native.get(role) else {
            return false;
        };
        if !matches!(role.as_str(), "application-bin" | "flash-arguments")
            && artifact != native_artifact
        {
            return false;
        }
    }
    let (Some(ck_application), Some(native_application)) =
        (ck.get("application-bin"), native.get("application-bin"))
    else {
        return false;
    };
    let application_exception_used = ck_application != native_application;
    if application_exception_used {
        if ck_application.0 != native_application.0
            || !ck_application.2
            || !native_application.2
            || ck_application.1 == native_application.1
        {
            return false;
        }
        let (Some(ck_raw), Some(native_raw)) = (
            run_unique_artifact_for_role(ck_run, "application-bin"),
            run_unique_artifact_for_role(native_run, "application-bin"),
        ) else {
            return false;
        };
        if !matches!(
            (
                esp_application_bin_immutable_segment_hashes(ck_raw, ck_application.0),
                esp_application_bin_immutable_segment_hashes(native_raw, native_application.0),
            ),
            (Some(ck_hashes), Some(native_hashes)) if ck_hashes == native_hashes
        ) {
            return false;
        }
    }
    if let (Some(ck_flash), Some(native_flash)) =
        (ck.get("flash-arguments"), native.get("flash-arguments"))
    {
        if ck_flash != native_flash {
            let (Some(ck_raw), Some(native_raw)) = (
                run_unique_artifact_for_role(ck_run, "flash-arguments"),
                run_unique_artifact_for_role(native_run, "flash-arguments"),
            ) else {
                return false;
            };
            let (Some((ck_options, ck_segments)), Some((native_options, native_segments))) = (
                esp_flash_args_normalized_witness(ck_raw, ck_flash.0),
                esp_flash_args_normalized_witness(native_raw, native_flash.0),
            ) else {
                return false;
            };
            if ck_options != native_options || ck_segments.len() != native_segments.len() {
                return false;
            }
            for (ck_segment, native_segment) in ck_segments.iter().zip(&native_segments) {
                if ck_segment.offset != native_segment.offset
                    || ck_segment.role != native_segment.role
                {
                    return false;
                }
                let (ck_payload, native_payload) =
                    match (&ck_segment.payload, &native_segment.payload) {
                        (Some(ck_payload), Some(native_payload)) => (ck_payload, native_payload),
                        (None, None) => {
                            // Both lanes flash this offset straight from the
                            // shared Core package; the exact reference name
                            // must agree, and the payload provenance is bound
                            // by the identical Core/toolchain identity checks.
                            if ck_segment.reference != native_segment.reference {
                                return false;
                            }
                            continue;
                        }
                        _ => return false,
                    };
                if ck_payload.0 != native_payload.0 {
                    return false;
                }
                if ck_payload.1 == native_payload.1 {
                    continue;
                }
                let segment_uses_application_exception = ck_segment.role == "application-bin"
                    && application_exception_used
                    && ck_payload.1 == ck_application.1
                    && native_payload.1 == native_application.1;
                if !segment_uses_application_exception {
                    return false;
                }
            }
        }
    }
    true
}

/// QuickFast compile-only ends at the linked application. Native Arduino CLI
/// may additionally emit upload packaging artifacts, so require one identical
/// shared primary application artifact rather than rejecting those extras.
/// Prefer ELF whenever either lane exposes it; falling through after an ELF
/// mismatch would weaken the semantic proof.
fn compile_only_application_artifacts_equivalent(
    ck_run: &serde_json::Value,
    native_run: &serde_json::Value,
) -> bool {
    let Some(ck) = run_artifacts_by_role(ck_run) else {
        return false;
    };
    let Some(native) = run_artifacts_by_role(native_run) else {
        return false;
    };
    if !run_artifact_set_is_bound(ck_run) || !run_artifact_set_is_bound(native_run) {
        return false;
    }
    let shared_primary = |role: &str| {
        matches!(
            (ck.get(role), native.get(role)),
            (Some(left), Some(right)) if left == right && left.2
        )
    };
    if ck.contains_key("application-elf") || native.contains_key("application-elf") {
        return shared_primary("application-elf");
    }
    [
        "application-bin",
        "avr-application-hex",
        "samd-application-bin",
        "samd-application-hex",
    ]
    .into_iter()
    .filter(|role| shared_primary(role))
    .count()
        == 1
}

fn ck_run_route_is_valid(
    run: &serde_json::Value,
    operation: ForgePerformanceOperation,
    profile: ForgePerformanceProfile,
) -> bool {
    if !supported_performance_operation_profile(operation, profile) {
        return false;
    }
    let operation_label = match operation {
        ForgePerformanceOperation::Compile => "compile",
        ForgePerformanceOperation::UploadReady => "upload-ready",
    };
    let profile_label = match profile {
        ForgePerformanceProfile::PortableFast => "portable-fast",
        ForgePerformanceProfile::QuickFast => "quick-fast",
        ForgePerformanceProfile::SharedFast => "shared-fast",
        ForgePerformanceProfile::NativeRelinkCompileOnly => return false,
    };
    let Some(recipe) = run.get("recipeCapability") else {
        return false;
    };
    let required = recipe
        .get("requiredCapabilities")
        .and_then(serde_json::Value::as_array);
    let missing = recipe
        .get("missingCapabilities")
        .and_then(serde_json::Value::as_array);
    json_string(run, "profile") == Some(profile_label)
        && json_string(run, "qualificationOperation") == Some(operation_label)
        && json_string(run, "qualificationProfile") == Some(profile_label)
        && json_string(run, "ckContractId") == Some(current_forge_contract_id())
        && recipe
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            == Some(2)
        && json_true(recipe, "observationOnly")
        && json_true(recipe, "capabilityGatePassed")
        && json_string(recipe, "baselineSha256").is_some_and(sha256_text_is_valid)
        && (profile != ForgePerformanceProfile::PortableFast
            || json_string(recipe, "intent") == Some(PORTABLE_FAST_RECIPE_INTENT))
        && required.is_some_and(|values| {
            !values.is_empty()
                && values
                    .iter()
                    .all(|value| value.as_str().is_some_and(|text| !text.trim().is_empty()))
                && values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    == values.len()
        })
        && missing.is_some_and(Vec::is_empty)
}

/// A qualification probe may exercise a candidate profile before that target
/// has earned a normal product fast route. That is safe only when the captured
/// CK run proves it came from the token-bound probe route and did not fall back
/// from that route. QuickFast proves its direct Fast Relink path; PortableFast
/// instead proves that the Core's native Arduino CLI recipe path used ccache.
fn ck_run_execution_is_qualification_safe(
    run: &serde_json::Value,
    stage: &str,
    profile: ForgePerformanceProfile,
) -> bool {
    if json_string(run, "candidateRoute") != Some(QUALIFICATION_TOKEN_CANDIDATE_ROUTE)
        || run.get("fallbackUsed").and_then(serde_json::Value::as_bool) != Some(false)
    {
        return false;
    }

    match profile {
        ForgePerformanceProfile::PortableFast => {
            // PortableFast deliberately preserves every Core recipe.  It can
            // use the platform's ordinary full/incremental Arduino CLI modes,
            // but neither FastRelink nor NativeRelink is evidence for it.
            json_true(run, "ccacheEnabled")
                && run
                    .get("recipeCapability")
                    .and_then(|recipe| json_string(recipe, "intent"))
                    == Some(PORTABLE_FAST_RECIPE_INTENT)
                && matches!(
                    json_string(run, "buildMode"),
                    Some(
                        "full-build"
                            | "arduino-cli-full-fallback"
                            | "arduino-cli-incremental"
                            | "arduino-cli-incremental-fallback"
                            | "arduino-cli-core-seeded"
                    )
                )
        }
        ForgePerformanceProfile::QuickFast | ForgePerformanceProfile::SharedFast => {
            match (stage, json_string(run, "buildMode")) {
                ("simple", Some("full-build" | "fast-relink")) => true,
                ("complex" | "medium" | "simple-return", Some("fast-relink")) => true,
                _ => false,
            }
        }
        ForgePerformanceProfile::NativeRelinkCompileOnly => false,
    }
}

#[derive(Clone)]
struct PortableStagePerformance {
    native_median_ms: u64,
    candidate_median_ms: u64,
    native_p95_ms: u64,
    candidate_p95_ms: u64,
    native_cv_basis_points: u32,
    candidate_cv_basis_points: u32,
}

fn portable_stage_performance(
    candidate: &serde_json::Value,
    stage: &str,
) -> Option<PortableStagePerformance> {
    let ck = candidate_stage_values(candidate, "ck", stage)?;
    let native = candidate_stage_values(candidate, "native", stage)?;
    let (native_median_ms, _) = median_bounds(native.clone())?;
    let (_, candidate_median_ms) = median_bounds(ck.clone())?;
    Some(PortableStagePerformance {
        native_median_ms,
        candidate_median_ms,
        native_p95_ms: p95(native.clone())?,
        candidate_p95_ms: p95(ck.clone())?,
        native_cv_basis_points: cv_basis_points(&native)?,
        candidate_cv_basis_points: cv_basis_points(&ck)?,
    })
}

fn portable_stage_performance_passes(stage: &PortableStagePerformance) -> bool {
    median_improves(stage.native_median_ms, stage.candidate_median_ms)
        && stage.candidate_p95_ms <= stage.native_p95_ms
        && stage.native_cv_basis_points <= MAX_CV_BASIS_POINTS
        && stage.candidate_cv_basis_points <= MAX_CV_BASIS_POINTS
}

fn candidate_identity_matches(
    identity: &serde_json::Value,
    fqbn: &str,
    core_version: &str,
    cli_version: &str,
    toolchain_key: &str,
    host_identity_sha256: &str,
    sketch_sha256: &str,
    cli_executable_sha256: &str,
    cli_config_sha256: &str,
    production_executable_sha256: &str,
) -> bool {
    let Some(toolchain_content_sha256) = toolchain_content_sha256(toolchain_key) else {
        return false;
    };
    json_string(identity, "fqbn") == Some(fqbn)
        && json_string(identity, "coreVersion") == Some(core_version)
        && json_string(identity, "cliVersion") == Some(cli_version)
        && json_string(identity, "toolchainKey") == Some(toolchain_key)
        && json_string(identity, "toolchainContentSha256") == Some(toolchain_content_sha256)
        && json_string(identity, "hostIdentitySha256") == Some(host_identity_sha256)
        && json_string(identity, "sketchSha256") == Some(sketch_sha256)
        && json_string(identity, "cliExecutableSha256") == Some(cli_executable_sha256)
        && json_string(identity, "cliConfigSha256") == Some(cli_config_sha256)
        && json_string(identity, "productionExecutableSha256") == Some(production_executable_sha256)
}

fn compute_qualification_key_with_policy(
    candidate: &serde_json::Value,
    performance_policy_id: &str,
) -> Option<String> {
    let identity = candidate.get("lanes")?.get("ck")?.get("identity")?;
    let mut value = serde_json::Map::new();
    for field in [
        "fqbn",
        "corePackage",
        "coreArchitecture",
        "coreVersion",
        "toolchainKey",
        "toolchainContentSha256",
        "sketchSha256",
        "cliExecutableSha256",
        "cliConfigSha256",
        "cliVersion",
        "hostIdentitySha256",
        "productionExecutableSha256",
    ] {
        value.insert(field.to_string(), identity.get(field)?.clone());
    }
    value.insert(
        "ckContractId".to_string(),
        candidate.get("ckContractId")?.clone(),
    );
    // Policy is part of the authorization identity, not merely report
    // presentation. Tightening the threshold must always produce a new
    // certificate directory instead of letting a legacy certificate collide.
    value.insert(
        "performancePolicyId".to_string(),
        serde_json::Value::String(performance_policy_id.to_string()),
    );
    value.insert(
        "candidateRoute".to_string(),
        serde_json::Value::String(QUALIFICATION_TOKEN_CANDIDATE_ROUTE.to_string()),
    );
    value.insert(
        "compilePropertyDelta".to_string(),
        candidate.get("compilePropertyDelta")?.clone(),
    );
    value.insert(
        "nativeBaselineCompilerPropertiesSha256".to_string(),
        candidate
            .get("nativeBaselineCompilerPropertiesSha256")?
            .clone(),
    );
    value.insert(
        "artifactEquivalencePolicyId".to_string(),
        candidate.get("artifactEquivalencePolicyId")?.clone(),
    );
    value.insert("operation".to_string(), candidate.get("operation")?.clone());
    value.insert(
        "candidateProfile".to_string(),
        candidate.get("candidateProfile")?.clone(),
    );
    value.insert(
        "measurementSequence".to_string(),
        candidate.get("measurementSequence")?.clone(),
    );
    value.insert(
        "sequenceSha256".to_string(),
        candidate.get("sequenceSha256")?.clone(),
    );
    Some(sha256_bytes(
        canonical_json(&serde_json::Value::Object(value)).as_bytes(),
    ))
}

pub(crate) fn compute_qualification_key(candidate: &serde_json::Value) -> Option<String> {
    compute_qualification_key_with_policy(candidate, PERFORMANCE_POLICY_ID)
}

#[allow(clippy::too_many_arguments)]
fn load_one_local_qualification(
    qualification_dir: &std::path::Path,
    canonical_fqbn: &str,
    core_version: &str,
    cli_version: &str,
    toolchain_key: &str,
    host_identity_sha256: &str,
    sketch_sha256: &str,
    cli_executable_sha256: &str,
    cli_config_sha256: &str,
    production_executable_sha256: &str,
) -> Option<(String, ForgePerformanceEvidence)> {
    let certificate_bytes = read_bounded_file(
        &qualification_dir.join("certificate.json"),
        MAX_QUALIFICATION_CERTIFICATE_BYTES,
    )?;
    let certificate =
        serde_json::from_slice::<LocalPerformanceCertificate>(&certificate_bytes).ok()?;
    if certificate.schema_id != LOCAL_QUALIFICATION_SCHEMA_ID
        || certificate.schema_version != 2
        || !sha256_text_is_valid(&certificate.candidate_sha256)
        || !sha256_text_is_valid(&certificate.report_sha256)
        || !sha256_text_is_valid(&certificate.artifact_manifest_sha256)
    {
        return None;
    }
    let candidate_bytes = read_bounded_file(
        &qualification_dir.join("candidate.json"),
        MAX_QUALIFICATION_JSON_BYTES,
    )?;
    let report_bytes = read_bounded_file(
        &qualification_dir.join("report.json"),
        MAX_QUALIFICATION_JSON_BYTES,
    )?;
    let artifact_manifest_bytes = read_bounded_file(
        &qualification_dir.join("artifact-manifest.json"),
        MAX_QUALIFICATION_JSON_BYTES,
    )?;
    let candidate_sha256 = sha256_bytes(&candidate_bytes);
    let report_sha256 = sha256_bytes(&report_bytes);
    if candidate_sha256 != certificate.candidate_sha256
        || report_sha256 != certificate.report_sha256
        || sha256_bytes(&artifact_manifest_bytes) != certificate.artifact_manifest_sha256
    {
        return None;
    }
    let (artifact_set_sha256, installed_artifacts) =
        validate_artifact_set(qualification_dir, &artifact_manifest_bytes)?;
    if artifact_set_sha256 != certificate.artifact_manifest_sha256 {
        return None;
    }
    let candidate = serde_json::from_slice::<serde_json::Value>(&candidate_bytes).ok()?;
    let report = serde_json::from_slice::<serde_json::Value>(&report_bytes).ok()?;
    let (operation, candidate_profile) = validated_operation_profile(&candidate)?;
    let expected_artifact_policy =
        fast_artifact_equivalence_policy_id(&candidate, operation, candidate_profile)?;
    let representative_run = candidate
        .get("lanes")?
        .get("native")?
        .get("trials")?
        .as_array()?
        .first()?
        .get("simple-return")?;
    if candidate_artifact_content_multiset(representative_run)? != installed_artifacts {
        return None;
    }
    if json_string(&candidate, "schemaId") != Some(PERFORMANCE_CANDIDATE_SCHEMA_ID)
        || candidate.get("schemaVersion")?.as_u64() != Some(PERFORMANCE_CANDIDATE_SCHEMA_VERSION)
        || json_string(&report, "schemaId") != Some(PERFORMANCE_REPORT_SCHEMA_ID)
        || report.get("schemaVersion")?.as_u64() != Some(PERFORMANCE_REPORT_SCHEMA_VERSION)
        || json_string(&report, "inputSha256") != Some(candidate_sha256.as_str())
        || json_string(&report, "sampleSetSha256") != Some(candidate_sha256.as_str())
        || json_string(&report, "hostIdentitySha256") != Some(host_identity_sha256)
        || !json_true(&report, "qualifiedFast")
        || json_string(&report, "status") != Some("qualified-fast")
        || json_string(&report, "recommendedRoute") != Some("ck-fast")
        || json_string(report.get("policy")?, "id") != Some(PERFORMANCE_POLICY_ID)
        || json_string(&candidate, "artifactEquivalencePolicyId") != Some(expected_artifact_policy)
        || candidate.get("artifactEquivalencePolicyId") != report.get("artifactEquivalencePolicyId")
        || candidate.get("portableFastEspApplicationBinRecipeProof")
            != report.get("portableFastEspApplicationBinRecipeProof")
        || json_string(&report, "measurementSequence") != Some(PERFORMANCE_MEASUREMENT_SEQUENCE)
        || candidate.get("measurementSequence") != report.get("measurementSequence")
        || candidate.get("sequenceSha256") != report.get("sequenceSha256")
        || !json_string(&candidate, "nativeBaselineCompilerPropertiesSha256")
            .is_some_and(sha256_text_is_valid)
        || candidate.get("nativeBaselineCompilerPropertiesSha256")
            != report.get("nativeBaselineCompilerPropertiesSha256")
        || !portable_edit_sequence_is_valid(&candidate)
        || !json_true(&report, "compileOnly")
        || report
            .get("uploadPerformed")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
        || report
            .get("hardwareTested")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
    {
        return None;
    }
    let report_stages = report.get("stages")?.as_array()?;
    if report_stages.len() != PORTABLE_EDIT_STAGES.len()
        || !report_stages
            .iter()
            .zip(PORTABLE_EDIT_STAGES)
            .all(|(stage, (expected_id, _))| {
                json_string(stage, "stage") == Some(expected_id)
                    && json_true(stage, "qualified")
                    && stage
                        .get("checks")
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|checks| {
                            !checks.is_empty()
                                && checks.iter().all(|check| json_true(check, "passed"))
                        })
            })
    {
        return None;
    }
    if serde_json::from_value::<ForgePerformanceOperation>(report.get("operation")?.clone()).ok()?
        != operation
        || serde_json::from_value::<ForgePerformanceProfile>(
            report.get("candidateProfile")?.clone(),
        )
        .ok()?
            != candidate_profile
        || json_string(&candidate, "ckContractId") != Some(current_forge_contract_id())
        || json_string(&report, "ckContractId") != Some(current_forge_contract_id())
        || candidate.get("compilePropertyDelta") != report.get("compilePropertyDelta")
        || json_string(&candidate, "compilePropertyDelta")
            .is_none_or(|value| value.trim().is_empty())
        || !controls_are_qualification_safe(candidate.get("controls")?)
        || !controls_are_qualification_safe(report.get("controls")?)
        || candidate.get("controls") != report.get("controls")
        || candidate.get("captureOrder") != report.get("captureOrder")
    {
        return None;
    }
    let ck_identity = candidate.get("lanes")?.get("ck")?.get("identity")?;
    let native_identity = candidate.get("lanes")?.get("native")?.get("identity")?;
    if ck_identity != native_identity
        || report.get("target")? != ck_identity
        || json_string(ck_identity, "sketchSha256") != Some(PORTABLE_EDIT_STAGES[0].1)
        || !candidate_identity_matches(
            ck_identity,
            canonical_fqbn,
            core_version,
            cli_version,
            toolchain_key,
            host_identity_sha256,
            sketch_sha256,
            cli_executable_sha256,
            cli_config_sha256,
            production_executable_sha256,
        )
    {
        return None;
    }
    let parsed = parse_complete_fqbn(canonical_fqbn)?;
    let platform = parsed.platform.split_once(':')?;
    if json_string(ck_identity, "corePackage") != Some(platform.0)
        || json_string(ck_identity, "coreArchitecture") != Some(platform.1)
    {
        return None;
    }
    let ck_trials = lane_trials(&candidate, "ck")?;
    let native_trials = lane_trials(&candidate, "native")?;
    let trial_ids = ck_trials
        .iter()
        .filter_map(|trial| json_string(trial, "id"))
        .collect::<std::collections::BTreeSet<_>>();
    if ck_trials.len() < MIN_PERFORMANCE_SAMPLES_PER_LANE as usize
        || ck_trials.len() > MAX_PERFORMANCE_SAMPLES_PER_LANE as usize
        || ck_trials.len() != native_trials.len()
        || trial_ids.len() != ck_trials.len()
        || candidate.get("captureOrder")?.as_array()?.len() != ck_trials.len()
        || !candidate
            .get("captureOrder")?
            .as_array()?
            .iter()
            .all(|value| matches!(value.as_str(), Some("ck-native" | "native-ck")))
        || !candidate
            .get("captureOrder")?
            .as_array()?
            .iter()
            .any(|value| value.as_str() == Some("ck-native"))
        || !candidate
            .get("captureOrder")?
            .as_array()?
            .iter()
            .any(|value| value.as_str() == Some("native-ck"))
        || !ck_trials.iter().zip(native_trials).all(|(ck, native)| {
            json_string(ck, "id").is_some() && json_string(ck, "id") == json_string(native, "id")
        })
        || report.get("trialCountPerLane")?.as_u64() != u64::try_from(ck_trials.len()).ok()
    {
        return None;
    }
    let mut ck_build_paths = std::collections::BTreeSet::new();
    let mut native_build_paths = std::collections::BTreeSet::new();
    let candidate_profile_label = match candidate_profile {
        ForgePerformanceProfile::PortableFast => "portable-fast",
        ForgePerformanceProfile::QuickFast => "quick-fast",
        ForgePerformanceProfile::SharedFast => "shared-fast",
        ForgePerformanceProfile::NativeRelinkCompileOnly => return None,
    };
    let native_baseline_sha256 = json_string(&candidate, "nativeBaselineCompilerPropertiesSha256")?;
    for (ck_trial, native_trial) in ck_trials.iter().zip(native_trials) {
        let mut ck_trial_path = None;
        let mut native_trial_path = None;
        for (stage_id, stage_sha256) in PORTABLE_EDIT_STAGES {
            let ck_run = ck_trial.get(stage_id)?;
            let native_run = native_trial.get(stage_id)?;
            run_wall_ms(ck_run)?;
            run_wall_ms(native_run)?;
            if json_string(ck_run, "codeSha256") != Some(stage_sha256)
                || json_string(native_run, "codeSha256") != Some(stage_sha256)
                || !ck_run_route_is_valid(ck_run, operation, candidate_profile)
                || !ck_run_execution_is_qualification_safe(ck_run, stage_id, candidate_profile)
                || json_string(native_run, "profile") != Some(candidate_profile_label)
                || json_string(native_run, "compilerPropertyDeltaSha256")
                    != Some(native_baseline_sha256)
                || run_resources(ck_run)? != run_resources(native_run)?
                || !(if expected_artifact_policy
                    == COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID
                {
                    compile_only_application_artifacts_equivalent(ck_run, native_run)
                } else if expected_artifact_policy
                    == PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID
                {
                    portable_fast_run_artifacts_equivalent(ck_run, native_run)
                } else {
                    generic_run_artifacts_equivalent(ck_run, native_run)
                })
            {
                return None;
            }
            let ck_path = json_string(ck_run, "buildPathIdentitySha256")?;
            let native_path = json_string(native_run, "buildPathIdentitySha256")?;
            if ck_trial_path.is_some_and(|value| value != ck_path)
                || native_trial_path.is_some_and(|value| value != native_path)
            {
                return None;
            }
            ck_trial_path = Some(ck_path);
            native_trial_path = Some(native_path);
        }
        if !ck_build_paths.insert(ck_trial_path?) || !native_build_paths.insert(native_trial_path?)
        {
            return None;
        }
    }
    let stage_performance = PORTABLE_EDIT_STAGES
        .iter()
        .map(|(stage, _)| portable_stage_performance(&candidate, stage))
        .collect::<Option<Vec<_>>>()?;
    if stage_performance.len() != PORTABLE_EDIT_STAGES.len()
        || !stage_performance
            .iter()
            .all(portable_stage_performance_passes)
    {
        return None;
    }
    let fresh = stage_performance.first()?.clone();
    let repeat = stage_performance
        .iter()
        .skip(1)
        .max_by(|left, right| {
            ((left.candidate_median_ms as u128) * (right.native_median_ms as u128))
                .cmp(&((right.candidate_median_ms as u128) * (left.native_median_ms as u128)))
                .then_with(|| {
                    right
                        .native_median_ms
                        .saturating_sub(right.candidate_median_ms)
                        .cmp(
                            &left
                                .native_median_ms
                                .saturating_sub(left.candidate_median_ms),
                        )
                })
        })?
        .clone();
    let evidence = ForgePerformanceEvidence {
        operation,
        candidate_profile,
        host_identity_sha256: host_identity_sha256.to_string(),
        sample_set_sha256: candidate_sha256,
        samples_per_lane: u32::try_from(ck_trials.len()).ok()?,
        native_fresh_median_ms: fresh.native_median_ms,
        candidate_fresh_median_ms: fresh.candidate_median_ms,
        native_repeat_median_ms: repeat.native_median_ms,
        candidate_repeat_median_ms: repeat.candidate_median_ms,
        native_fresh_p95_ms: fresh.native_p95_ms,
        candidate_fresh_p95_ms: fresh.candidate_p95_ms,
        native_repeat_p95_ms: repeat.native_p95_ms,
        candidate_repeat_p95_ms: repeat.candidate_p95_ms,
        native_fresh_cv_basis_points: fresh.native_cv_basis_points,
        candidate_fresh_cv_basis_points: fresh.candidate_cv_basis_points,
        native_repeat_cv_basis_points: repeat.native_cv_basis_points,
        candidate_repeat_cv_basis_points: repeat.candidate_cv_basis_points,
        artifact_equivalent: true,
        resource_equivalent: true,
        evidence_sha256: report_sha256,
        artifact_set_sha256,
    };
    if !performance_ab_passes(&evidence) {
        return None;
    }
    let qualification_key = compute_qualification_key(&candidate)?;
    if json_string(&report, "qualificationKey") != Some(qualification_key.as_str())
        || qualification_dir.file_name()?.to_str()? != qualification_key
    {
        return None;
    }
    Some((qualification_key, evidence))
}

/// Read-only local performance certificate loader. It never creates or
/// repairs evidence. Missing, malformed, stale, cross-machine, or hash-mismatched
/// certificates simply return `None`, preserving the native Release route.
#[allow(clippy::too_many_arguments)]
pub fn load_local_qualification(
    sysroot_root: &std::path::Path,
    fqbn: &str,
    core_version: &str,
    cli_version: &str,
    toolchain_key: &str,
    sketch_sha256: &str,
) -> Option<ForgeQualificationEvidence> {
    let parsed = parse_complete_fqbn(fqbn)?;
    let core_version = core_version.trim();
    let cli_version = cli_version.trim();
    let toolchain_key = toolchain_key.trim();
    if Version::parse(core_version).is_err()
        || cli_version.is_empty()
        || toolchain_key.is_empty()
        || !sha256_text_is_valid(sketch_sha256)
    {
        return None;
    }
    let root = sysroot_root.join("state").join("qualifications");
    let metadata = std::fs::symlink_metadata(&root).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    let canonical_root = root.canonicalize().ok()?;
    let mut directories = Vec::new();
    let mut probes = 0_usize;
    for entry in std::fs::read_dir(&root).ok()? {
        probes = probes.saturating_add(1);
        if probes > MAX_LOCAL_PERFORMANCE_DIRECTORY_PROBES {
            return None;
        }
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.file_type().ok().is_some_and(|kind| kind.is_dir())
            || !may_contain_local_performance_certificate(&entry.path())
        {
            continue;
        }
        directories.push(entry.path());
        if directories.len() > MAX_LOCAL_PERFORMANCE_QUALIFICATIONS {
            return None;
        }
    }
    directories.sort();
    if directories.is_empty() {
        // NativeRelink v4 certificates share the qualification root but cannot
        // grant a PortableFast/QuickFast/SharedFast capability. Avoid reading and hashing the
        // 30-40 MiB Arduino CLI when no v2 performance certificate is present.
        return None;
    }
    let host_identity = host_environment_fingerprint(sysroot_root);
    let candidate_directories = directories
        .into_iter()
        .filter(|directory| {
            may_match_local_performance_identity(
                directory,
                &parsed.canonical_fqbn,
                core_version,
                cli_version,
                toolchain_key,
                &host_identity,
                sketch_sha256,
            )
        })
        .collect::<Vec<_>>();
    if candidate_directories.is_empty() {
        // No candidate can match this exact request. This denial-only hint
        // avoids hashing stale certificate inputs while preserving the full
        // path for every positive candidate.
        return None;
    }
    // Avoid hashing the 30-40 MiB CLI binary on the normal no-certificate
    // route. Expensive identity work begins only after a bounded directory has
    // proved it contains the schema this loader can actually accept.
    let cli_executable = if cfg!(windows) {
        sysroot_root.join("bin").join("arduino-cli.exe")
    } else {
        sysroot_root.join("bin").join("arduino-cli")
    };
    let cli_bytes = read_bounded_file(&cli_executable, 128 * 1024 * 1024)?;
    let cli_executable_sha256 = sha256_bytes(&cli_bytes);
    let cli_config_bytes = read_bounded_file(
        &sysroot_root.join("arduino-cli-fast.yaml"),
        MAX_QUALIFICATION_JSON_BYTES,
    )?;
    let cli_config_sha256 = sha256_bytes(&cli_config_bytes);
    let production_executable_sha256 = current_production_executable_sha256()?;
    let mut performance_ab = Vec::new();
    let mut capabilities = std::collections::BTreeSet::new();
    for directory in candidate_directories {
        let Ok(canonical) = directory.canonicalize() else {
            continue;
        };
        if !canonical.starts_with(&canonical_root) {
            continue;
        }
        let Some((_, evidence)) = load_one_local_qualification(
            &canonical,
            &parsed.canonical_fqbn,
            core_version,
            cli_version,
            toolchain_key,
            &host_identity,
            sketch_sha256,
            &cli_executable_sha256,
            &cli_config_sha256,
            &production_executable_sha256,
        ) else {
            continue;
        };
        if !capabilities.insert((evidence.operation, evidence.candidate_profile)) {
            return None;
        }
        performance_ab.push(evidence);
    }
    if performance_ab.is_empty() {
        return None;
    }
    Some(ForgeQualificationEvidence {
        status: ForgeQualificationStatus::Passed,
        canonical_fqbn: parsed.canonical_fqbn,
        core_version: core_version.to_string(),
        cli_version: cli_version.to_string(),
        toolchain_key: toolchain_key.to_string(),
        contract_id: current_forge_contract_id().to_string(),
        performance_ab,
    })
}

#[derive(Debug)]
struct NativeRelinkQualification {
    qualification_key: String,
    fqbn: String,
    core_version: String,
    cli_version: String,
    cli_executable_sha256: String,
    host_identity_sha256: String,
    production_executable_sha256: String,
    toolchain_key: String,
    sequence_sha256: String,
    ck_contract_id: String,
    adapter_id: String,
    engine_contract_id: String,
    artifact_policy_id: String,
    trial_count: usize,
}

fn json_false(value: &serde_json::Value, key: &str) -> bool {
    value.get(key).and_then(serde_json::Value::as_bool) == Some(false)
}

fn matching_native_relink_adapter(
    fqbn: &str,
    core_architecture: Option<&str>,
    controls: &serde_json::Value,
) -> Option<&'static NativeRelinkAdapterDescriptor> {
    let adapter = native_relink_adapter_for(fqbn, core_architecture)?;
    (json_string(controls, "nativeRelinkAdapterId") == Some(adapter.id)
        && json_string(controls, "nativeRelinkEngineContractId")
            == Some(adapter.engine_contract_id)
        && json_string(controls, "artifactEquivalencePolicyId") == Some(adapter.artifact_policy_id))
    .then_some(adapter)
}

pub(crate) fn native_relink_adapter_contract_matches(
    fqbn: &str,
    core_architecture: Option<&str>,
    controls: &serde_json::Value,
) -> bool {
    matching_native_relink_adapter(fqbn, core_architecture, controls).is_some()
}

fn json_positive_f64(value: &serde_json::Value, key: &str) -> Option<f64> {
    value
        .get(key)?
        .as_f64()
        .filter(|number| number.is_finite() && *number > 0.0)
}

fn portable_edit_sequence_sha256() -> String {
    let stages = PORTABLE_EDIT_STAGES
        .iter()
        .map(|(id, source_sha256)| serde_json::json!({ "id": id, "sourceSha256": source_sha256 }))
        .collect::<Vec<_>>();
    sha256_bytes(canonical_json(&serde_json::Value::Array(stages)).as_bytes())
}

fn native_relink_qualification_key(
    fqbn: &str,
    core_version: &str,
    toolchain_key: &str,
    cli_version: &str,
    cli_executable_sha256: &str,
    host_identity_sha256: &str,
    production_executable_sha256: &str,
    sequence_sha256: &str,
    ck_contract_id: &str,
) -> String {
    // This wrapper uses the current AVR binding v3. New adapters should call
    // `native_relink_qualification_key_for_adapter` explicitly so their
    // engine identity is cryptographically separated from AVR.
    native_relink_qualification_key_for_adapter(
        fqbn,
        core_version,
        toolchain_key,
        cli_version,
        cli_executable_sha256,
        host_identity_sha256,
        production_executable_sha256,
        sequence_sha256,
        ck_contract_id,
        &AVR_NATIVE_RELINK_ADAPTER,
    )
}

fn native_relink_qualification_key_for_adapter(
    fqbn: &str,
    core_version: &str,
    toolchain_key: &str,
    cli_version: &str,
    cli_executable_sha256: &str,
    host_identity_sha256: &str,
    production_executable_sha256: &str,
    sequence_sha256: &str,
    ck_contract_id: &str,
    adapter: &NativeRelinkAdapterDescriptor,
) -> String {
    let binding = serde_json::json!({
        "schemaId": "ck.forge.native-relink-local-binding",
        "schemaVersion": NATIVE_RELINK_BINDING_SCHEMA_VERSION,
        "profile": NATIVE_RELINK_PROFILE_ID,
        "performancePolicyId": NATIVE_RELINK_POLICY_ID,
        "fqbn": fqbn,
        "coreVersion": core_version,
        "toolchainKey": toolchain_key,
        "cliVersion": cli_version,
        "cliExecutableSha256": cli_executable_sha256,
        "hostIdentitySha256": host_identity_sha256,
        "productionExecutableSha256": production_executable_sha256,
        "sequenceSha256": sequence_sha256,
        "ckContractId": ck_contract_id,
        // The engine contract is lane-unique. Future adapters must use a
        // distinct engine contract and validate their artifact policy in the
        // evidence body rather than inheriting AVR identity.
        "nativeRelinkContractId": adapter.engine_contract_id,
    });
    sha256_bytes(canonical_json(&binding).as_bytes())
}

fn native_artifact_set_sha256(artifacts: &[serde_json::Value]) -> Option<String> {
    let mut normalized = Vec::with_capacity(artifacts.len());
    for artifact in artifacts {
        let name = json_string(artifact, "name")?;
        let role = json_string(artifact, "role")?;
        let bytes = artifact.get("bytes")?.as_u64().filter(|value| *value > 0)?;
        let sha256 = json_string(artifact, "sha256").filter(|value| sha256_text_is_valid(value))?;
        let primary = artifact.get("primaryApplication")?.as_bool()?;
        normalized.push(serde_json::json!({
            "name": name,
            "bytes": bytes,
            "sha256": sha256,
            "primaryApplication": primary,
            "role": role,
        }));
    }
    Some(sha256_bytes(
        canonical_json(&serde_json::Value::Array(normalized)).as_bytes(),
    ))
}

fn native_run_integrity_projection(run: &serde_json::Value) -> serde_json::Value {
    let mut unsigned = run.clone();
    let Some(object) = unsigned.as_object_mut() else {
        return unsigned;
    };
    let integrity_v2 = object
        .get("integritySchemaVersion")
        .and_then(serde_json::Value::as_u64)
        == Some(2);
    object.remove("evidenceSha256");
    if integrity_v2 {
        object.remove("wallMs");
        let runner_wall_ns = object
            .get("rawTiming")
            .and_then(serde_json::Value::as_object)
            .and_then(|timing| timing.get("runnerWallNs"))
            .cloned();
        let mut timing = serde_json::Map::new();
        if let Some(runner_wall_ns) = runner_wall_ns {
            timing.insert("runnerWallNs".to_string(), runner_wall_ns);
        }
        object.insert("rawTiming".to_string(), serde_json::Value::Object(timing));
    }
    unsigned
}

fn native_run_wall_ms(run: &serde_json::Value, expected_source_sha256: &str) -> Option<f64> {
    if !json_true(run, "success")
        || !json_true(run, "compileOnly")
        || !json_false(run, "uploadPerformed")
        || !json_false(run, "exactUsed")
        || json_string(run, "codeSha256") != Some(expected_source_sha256)
        || !json_true(run, "artifactsVerified")
    {
        return None;
    }
    let evidence_sha256 = json_string(run, "evidenceSha256")?;
    if !sha256_text_is_valid(evidence_sha256) {
        return None;
    }
    let integrity_v2 = run
        .get("integritySchemaVersion")
        .and_then(serde_json::Value::as_u64)
        == Some(2);
    let reported_wall_ms = json_positive_f64(run, "wallMs")?;
    let wall_ms = if integrity_v2 {
        let runner_wall_ns = json_string(run.get("rawTiming")?, "runnerWallNs")?;
        let runner_wall_ns = runner_wall_ns.parse::<u128>().ok()?;
        if runner_wall_ns == 0 {
            return None;
        }
        let derived = runner_wall_ns as f64 / 1_000_000.0;
        if !derived.is_finite() || (reported_wall_ms - derived).abs() > 0.01 {
            return None;
        }
        derived
    } else {
        reported_wall_ms
    };
    let recomputed_evidence_sha256 =
        sha256_bytes(canonical_json(&native_run_integrity_projection(run)).as_bytes());
    if recomputed_evidence_sha256 != evidence_sha256 {
        return None;
    }
    let artifacts = run.get("artifacts")?.as_array()?;
    if artifacts.is_empty()
        || artifacts.len() > MAX_QUALIFICATION_ARTIFACTS
        || native_artifact_set_sha256(artifacts)? != json_string(run, "artifactSetSha256")?
    {
        return None;
    }
    let resources = run.get("resources")?;
    if !json_true(resources, "evidenceComplete")
        || resources.get("flashUsedBytes")?.as_u64().is_none()
        || resources.get("ramUsedBytes")?.as_u64().is_none()
    {
        return None;
    }
    Some(wall_ms)
}

fn unique_artifact_for_role<'a>(
    artifacts: &'a [serde_json::Value],
    role: &str,
) -> Option<&'a serde_json::Value> {
    let mut matching = artifacts
        .iter()
        .filter(|artifact| json_string(artifact, "role") == Some(role));
    let artifact = matching.next()?;
    matching.next().is_none().then_some(artifact)
}

fn artifact_role_matches(
    ck_artifacts: &[serde_json::Value],
    native_artifacts: &[serde_json::Value],
    role: &str,
) -> bool {
    let Some(ck) = unique_artifact_for_role(ck_artifacts, role) else {
        return false;
    };
    let Some(native) = unique_artifact_for_role(native_artifacts, role) else {
        return false;
    };
    ck.get("bytes").and_then(serde_json::Value::as_u64)
        == native.get("bytes").and_then(serde_json::Value::as_u64)
        && json_string(ck, "sha256") == json_string(native, "sha256")
}

/// A witness role is exactly one same-length primary application image per
/// lane. Equal digests pass directly; a digest mismatch must be covered by a
/// valid ESP payload witness on BOTH lanes whose fixed layouts agree (equal
/// byte lengths pin every offset/length) and whose immutable segments hash
/// byte-equal, leaving only the embedded ELF SHA-256 window and the validated
/// image footer free to differ across lanes.
fn witness_artifact_role_matches(
    ck_artifacts: &[serde_json::Value],
    native_artifacts: &[serde_json::Value],
    role: &str,
) -> bool {
    let Some(ck) = unique_artifact_for_role(ck_artifacts, role) else {
        return false;
    };
    let Some(native) = unique_artifact_for_role(native_artifacts, role) else {
        return false;
    };
    let (Some(ck_bytes), Some(native_bytes)) = (
        ck.get("bytes").and_then(serde_json::Value::as_u64),
        native.get("bytes").and_then(serde_json::Value::as_u64),
    ) else {
        return false;
    };
    if ck_bytes != native_bytes
        || !json_true(ck, "primaryApplication")
        || !json_true(native, "primaryApplication")
    {
        return false;
    }
    let (Some(ck_sha256), Some(native_sha256)) =
        (json_string(ck, "sha256"), json_string(native, "sha256"))
    else {
        return false;
    };
    if !sha256_text_is_valid(ck_sha256) || !sha256_text_is_valid(native_sha256) {
        return false;
    }
    if ck_sha256 == native_sha256 {
        return true;
    }
    matches!(
        (
            esp_application_bin_immutable_segment_hashes(ck, ck_bytes),
            esp_application_bin_immutable_segment_hashes(native, native_bytes),
        ),
        (Some(ck_hashes), Some(native_hashes)) if ck_hashes == native_hashes
    )
}

fn optional_artifact_role_matches(
    ck_artifacts: &[serde_json::Value],
    native_artifacts: &[serde_json::Value],
    role: &str,
) -> bool {
    let ck = ck_artifacts
        .iter()
        .filter(|artifact| json_string(artifact, "role") == Some(role))
        .collect::<Vec<_>>();
    let native = native_artifacts
        .iter()
        .filter(|artifact| json_string(artifact, "role") == Some(role))
        .collect::<Vec<_>>();
    if ck.is_empty() && native.is_empty() {
        return true;
    }
    ck.len() == 1
        && native.len() == 1
        && ck[0].get("bytes").and_then(serde_json::Value::as_u64)
            == native[0].get("bytes").and_then(serde_json::Value::as_u64)
        && json_string(ck[0], "sha256") == json_string(native[0], "sha256")
}

fn median_f64(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty()
        || values
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len() % 2 == 1 {
        values.get(middle).copied()
    } else {
        Some((values[middle - 1] + values[middle]) / 2.0)
    }
}

fn p95_f64(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty()
        || values
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let rank = (95_usize.checked_mul(values.len())?.saturating_add(99)) / 100;
    values.get(rank.saturating_sub(1)).copied()
}

fn recompute_native_relink_qualification(
    evidence: &serde_json::Value,
    evidence_sha256: &str,
) -> Option<NativeRelinkQualification> {
    if json_string(evidence, "schemaId") != Some(NATIVE_RELINK_RUN_SCHEMA_ID)
        || evidence.get("schemaVersion")?.as_u64() != Some(2)
        || json_string(evidence, "measurementStatus") != Some("passed")
        || !evidence.get("failures")?.as_array()?.is_empty()
        || !json_true(evidence.get("runner")?, "unchanged")
        || !json_true(evidence.get("productionExecutable")?, "unchanged")
        || !sha256_text_is_valid(evidence_sha256)
    {
        return None;
    }
    let checks = evidence.get("checks")?.as_array()?;
    if checks.is_empty() || checks.iter().any(|check| !json_true(check, "passed")) {
        return None;
    }
    let controls = evidence.get("controls")?;
    if [
        "compileOnly",
        "sameMachine",
        "sameBundledCli",
        "sameCliConfig",
        "sameCoreAndCompleteFqbn",
        "sameSourceBytes",
        "sameParallelJobs",
        "globalCachesSharedEqually",
        "externalShortBuildPaths",
        "sequentialNoConcurrentCompiles",
        "ckQualificationMode",
        "sameBuildPathWithinLane",
        "qualificationTokenBound",
    ]
    .iter()
    .any(|field| !json_true(controls, field))
        || [
            "uploadPerformed",
            "physicalFlashWritten",
            "serialPortAccessed",
            "exactAllowed",
            "exactCountedAsFresh",
        ]
        .iter()
        .any(|field| !json_false(controls, field))
        || json_string(controls, "measurementSequence") != Some("portable-edit")
        || json_string(controls, "requiredCkMode") != Some(NATIVE_RELINK_PROFILE_ID)
    {
        return None;
    }
    let identity = evidence.get("identity")?;
    let parsed = parse_complete_fqbn(json_string(identity, "fqbn")?)?;
    if parsed.complete != parsed.canonical_fqbn {
        return None;
    }
    let fqbn = parsed.canonical_fqbn;
    let adapter =
        matching_native_relink_adapter(&fqbn, json_string(identity, "coreArchitecture"), controls)?;
    let core_version = json_string(identity, "coreVersion")?.to_string();
    let cli_version = json_string(identity, "cliVersion")?.to_string();
    let cli_executable_sha256 = json_string(identity, "cliExecutableSha256")?.to_string();
    let host_identity_sha256 = json_string(identity, "hostIdentitySha256")?.to_string();
    let production_executable_sha256 =
        json_string(identity, "productionExecutableSha256")?.to_string();
    let sequence_sha256 = json_string(identity, "sequenceSha256")?.to_string();
    if !sha256_text_is_valid(&cli_executable_sha256)
        || !sha256_text_is_valid(&host_identity_sha256)
        || sequence_sha256 != portable_edit_sequence_sha256()
        || !["runnerSha256", "productionExecutableSha256"]
            .iter()
            .all(|field| json_string(identity, field).is_some_and(sha256_text_is_valid))
    {
        return None;
    }
    let production_executable = evidence.get("productionExecutable")?;
    if json_string(production_executable.get("before")?, "executableSha256")
        != Some(production_executable_sha256.as_str())
        || json_string(production_executable.get("after")?, "executableSha256")
            != Some(production_executable_sha256.as_str())
    {
        return None;
    }
    let expected_stages = PORTABLE_EDIT_STAGES
        .iter()
        .map(|(id, source_sha256)| serde_json::json!({ "id": id, "sourceSha256": source_sha256 }))
        .collect::<Vec<_>>();
    if evidence.get("stages")?.as_array()? != &expected_stages {
        return None;
    }
    let trials = evidence.get("trials")?.as_array()?;
    let capture_order = evidence.get("captureOrder")?.as_array()?;
    if trials.len() < NATIVE_RELINK_REQUIRED_TRIALS
        || trials.len() > MAX_PERFORMANCE_SAMPLES_PER_LANE as usize
        || capture_order.len() != trials.len()
        || !capture_order
            .iter()
            .all(|entry| matches!(entry.as_str(), Some("ck-native" | "native-ck")))
        || !capture_order.iter().any(|entry| entry == "ck-native")
        || !capture_order.iter().any(|entry| entry == "native-ck")
    {
        return None;
    }
    let mut trial_ids = std::collections::BTreeSet::new();
    let mut toolchain_keys = std::collections::BTreeSet::new();
    let mut contract_ids = std::collections::BTreeSet::new();
    let mut ck_times = std::collections::BTreeMap::<&str, Vec<f64>>::new();
    let mut native_times = std::collections::BTreeMap::<&str, Vec<f64>>::new();
    for (index, trial) in trials.iter().enumerate() {
        let trial_id = json_string(trial, "id")?;
        if !trial_ids.insert(trial_id.to_string())
            || json_string(trial, "order") != capture_order[index].as_str()
        {
            return None;
        }
        let ck_lane = trial.get("ck")?;
        let native_lane = trial.get("native")?;
        let cache_clear = ck_lane.get("cacheClear")?;
        if json_string(cache_clear, "reset_scope") != Some("first-project-full-fqbn")
            || !json_false(cache_clear, "force_rebuild_pending")
            || !json_true(cache_clear, "ccache_store_preserved")
        {
            return None;
        }
        for (stage, source_sha256) in PORTABLE_EDIT_STAGES {
            let ck = ck_lane.get(stage)?;
            let native = native_lane.get(stage)?;
            let ck_wall = native_run_wall_ms(ck, source_sha256)?;
            let native_wall = native_run_wall_ms(native, source_sha256)?;
            if parse_complete_fqbn(json_string(ck, "fqbn")?)?.canonical_fqbn != fqbn
                || parse_complete_fqbn(json_string(native, "fqbn")?)?.canonical_fqbn != fqbn
                || json_string(ck, "cliVersion") != Some(cli_version.as_str())
                || json_string(ck.get("route")?, "coreVersion") != Some(core_version.as_str())
            {
                return None;
            }
            toolchain_keys.insert(json_string(ck, "toolchainKey")?.to_string());
            contract_ids.insert(json_string(ck.get("route")?, "contractId")?.to_string());
            let ck_resources = ck.get("resources")?;
            let native_resources = native.get("resources")?;
            if ck_resources.get("flashUsedBytes") != native_resources.get("flashUsedBytes")
                || ck_resources.get("ramUsedBytes") != native_resources.get("ramUsedBytes")
            {
                return None;
            }
            let ck_artifacts = ck.get("artifacts")?.as_array()?;
            let native_artifacts = native.get("artifacts")?.as_array()?;
            if adapter
                .required_artifact_roles
                .iter()
                .any(|role| !artifact_role_matches(ck_artifacts, native_artifacts, role))
                || adapter.witness_artifact_roles.iter().any(|role| {
                    !witness_artifact_role_matches(ck_artifacts, native_artifacts, role)
                })
                || adapter.optional_artifact_roles.iter().any(|role| {
                    !optional_artifact_role_matches(ck_artifacts, native_artifacts, role)
                })
            {
                return None;
            }
            let all_stage_forbidden_artifact_present = [ck_artifacts, native_artifacts]
                .into_iter()
                .flatten()
                .any(|artifact| {
                    json_string(artifact, "role").is_some_and(|role| {
                        adapter.forbidden_all_stage_artifact_roles.contains(&role)
                    })
                });
            let ck_edit_forbidden_artifact_present = stage != "simple"
                && ck_artifacts.iter().any(|artifact| {
                    json_string(artifact, "role").is_some_and(|role| {
                        adapter.forbidden_ck_edit_artifact_roles.contains(&role)
                    })
                });
            if all_stage_forbidden_artifact_present
                || ck_edit_forbidden_artifact_present
                || (stage != "simple"
                    && json_string(ck, "buildMode") != Some(NATIVE_RELINK_PROFILE_ID))
            {
                return None;
            }
            if NATIVE_RELINK_EDIT_STAGES.contains(&stage) {
                ck_times.entry(stage).or_default().push(ck_wall);
                native_times.entry(stage).or_default().push(native_wall);
            }
        }
    }
    if toolchain_keys.len() != 1 || contract_ids.len() != 1 {
        return None;
    }
    for stage in NATIVE_RELINK_EDIT_STAGES {
        let ck = ck_times.remove(stage)?;
        let native = native_times.remove(stage)?;
        let ck_median = median_f64(ck.clone())?;
        let native_median = median_f64(native.clone())?;
        let median_gain = native_median - ck_median;
        if median_gain < MIN_ABSOLUTE_SAVING_MS as f64
            || ck_median * 10_000.0 > native_median * (10_000 - MIN_IMPROVEMENT_BASIS_POINTS) as f64
            || p95_f64(ck)? > p95_f64(native)?
        {
            return None;
        }
    }
    let toolchain_key = toolchain_keys.into_iter().next()?;
    let ck_contract_id = contract_ids.into_iter().next()?;
    let qualification_key = native_relink_qualification_key_for_adapter(
        &fqbn,
        &core_version,
        &toolchain_key,
        &cli_version,
        &cli_executable_sha256,
        &host_identity_sha256,
        &production_executable_sha256,
        &sequence_sha256,
        &ck_contract_id,
        adapter,
    );
    Some(NativeRelinkQualification {
        qualification_key,
        fqbn,
        core_version,
        cli_version,
        cli_executable_sha256,
        host_identity_sha256,
        production_executable_sha256,
        toolchain_key,
        sequence_sha256,
        ck_contract_id,
        adapter_id: adapter.id.to_string(),
        engine_contract_id: adapter.engine_contract_id.to_string(),
        artifact_policy_id: adapter.artifact_policy_id.to_string(),
        trial_count: trials.len(),
    })
}

/// Return the immutable raw A/B evidence SHA for a matching local
/// `NativeRelinkCompileOnly` certificate. This loader is read-only and
/// fail-closed: it re-hashes both files and recomputes all three edit-stage
/// performance, route, artifact, resource, host, production-executable and
/// toolchain gates. The cold `simple` baseline is checked for correctness but
/// is deliberately not required to beat native Arduino CLI.
fn load_native_relink_evidence_sha256_from_root(
    sysroot_root: &std::path::Path,
    qualification_root: &std::path::Path,
    fqbn: &str,
    core_version: &str,
    cli_version: &str,
    toolchain_key: &str,
    allow_portable_host_identity: bool,
) -> Option<String> {
    let lookup_fqbn = native_relink_default_complete_fqbn(fqbn);
    let parsed = parse_complete_fqbn(&lookup_fqbn)?;
    let core_version = core_version.trim();
    let cli_version = cli_version.trim();
    let toolchain_key = toolchain_key.trim();
    // Menu order is not a different target. Canonicalize only the certificate
    // lookup; the caller's FQBN, compiler macro and build identity stay intact.
    // Evidence itself still has to be canonical, and duplicate/malformed menu
    // keys remain rejected by parse_complete_fqbn.
    if parsed.complete.chars().any(char::is_whitespace)
        || Version::parse(core_version).is_err()
        || cli_version.is_empty()
        || toolchain_key.is_empty()
    {
        return None;
    }
    let root = qualification_root;
    let metadata = std::fs::symlink_metadata(&root).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    let canonical_root = root.canonicalize().ok()?;
    let adapter = native_relink_adapter_for(&parsed.canonical_fqbn, None)?;
    let hint_scan_budget = if allow_portable_host_identity {
        MAX_BUNDLED_QUALIFICATION_HINT_SCAN
    } else {
        MAX_LOCAL_QUALIFICATION_HINT_SCAN
    };
    match scan_native_relink_hints_with_budget(
        &root,
        &canonical_root,
        &parsed.canonical_fqbn,
        core_version,
        cli_version,
        toolchain_key,
        adapter,
        hint_scan_budget,
    )? {
        NativeRelinkHintScan::CompleteNoMatch => {
            // This is a denial-only optimization. A small store with no
            // matching hint stays on Arduino CLI Release without hashing the
            // large bundled CLI executable. A large store intentionally falls
            // through to exact-key lookup instead of invalidating all rows.
            return None;
        }
        NativeRelinkHintScan::ExactTargetPresent | NativeRelinkHintScan::BudgetExceeded => {}
    }
    // From here on, only the current executable/host/CLI identity can produce
    // the key. No sibling certificate is trusted or opened.
    let host_identity_sha256 = host_environment_fingerprint(sysroot_root);
    let cli_executable = if cfg!(windows) {
        sysroot_root.join("bin").join("arduino-cli.exe")
    } else {
        sysroot_root.join("bin").join("arduino-cli")
    };
    let cli_executable_sha256 =
        managed_cli_executable_sha256(&cli_executable, MAX_QUALIFICATION_ARTIFACT_BYTES)?;
    let production_executable_sha256 = current_production_executable_sha256()?;
    let sequence_sha256 = portable_edit_sequence_sha256();
    let qualification_key = native_relink_qualification_key_for_adapter(
        &parsed.canonical_fqbn,
        core_version,
        toolchain_key,
        cli_version,
        &cli_executable_sha256,
        &host_identity_sha256,
        &production_executable_sha256,
        &sequence_sha256,
        current_forge_contract_id(),
        adapter,
    );
    // A certificate's executable hash is retained as immutable provenance,
    // while the versioned Forge contract authenticates the compiler engine.
    // Direct-overwrite installs therefore keep using a valid certificate from
    // the previous desktop build instead of invalidating every board because
    // the UI bundle changed. New certificates still use the exact-key fast
    // path; legacy-key lookup is bounded and fully revalidated below.
    let exact_directory =
        exact_local_qualification_directory(&root, &canonical_root, &qualification_key);
    let qualification_dir = exact_directory.clone().or_else(|| {
        find_native_relink_target_directory_with_budget(
            &root,
            &canonical_root,
            &parsed.canonical_fqbn,
            core_version,
            cli_version,
            toolchain_key,
            adapter,
            if allow_portable_host_identity {
                MAX_BUNDLED_PERFORMANCE_DIRECTORY_PROBES
            } else {
                MAX_LOCAL_PERFORMANCE_DIRECTORY_PROBES
            },
        )
    })?;
    let certificate_bytes = read_bounded_file(
        &qualification_dir.join("certificate.json"),
        MAX_QUALIFICATION_CERTIFICATE_BYTES,
    )?;
    let certificate =
        serde_json::from_slice::<LocalNativeRelinkCertificate>(&certificate_bytes).ok()?;
    if certificate.schema_id != LOCAL_QUALIFICATION_SCHEMA_ID
        || certificate.schema_version != 4
        || certificate.candidate_profile != NATIVE_RELINK_PROFILE_ID
        || !sha256_text_is_valid(&certificate.evidence_sha256)
        || !sha256_text_is_valid(&certificate.report_sha256)
    {
        return None;
    }
    let evidence_bytes = read_bounded_file(
        &qualification_dir.join("evidence.json"),
        MAX_QUALIFICATION_JSON_BYTES,
    )?;
    let report_bytes = read_bounded_file(
        &qualification_dir.join("report.json"),
        MAX_QUALIFICATION_JSON_BYTES,
    )?;
    if sha256_bytes(&evidence_bytes) != certificate.evidence_sha256
        || sha256_bytes(&report_bytes) != certificate.report_sha256
    {
        return None;
    }
    let evidence = serde_json::from_slice::<serde_json::Value>(&evidence_bytes).ok()?;
    let recomputed =
        recompute_native_relink_qualification(&evidence, &certificate.evidence_sha256)?;
    // The report/key pair must agree with the executable hash recorded by the
    // evidence. When the current desktop executable differs, that old hash is
    // intentionally accepted only because all compiler-engine contracts and
    // target identities below still match exactly.
    if qualification_dir.file_name()?.to_str()? != recomputed.qualification_key
        || recomputed.fqbn != parsed.canonical_fqbn
        || recomputed.core_version != core_version
        || recomputed.cli_version != cli_version
        || recomputed.cli_executable_sha256 != cli_executable_sha256
        || (!allow_portable_host_identity
            && recomputed.host_identity_sha256 != host_identity_sha256)
        || recomputed.toolchain_key != toolchain_key
        || recomputed.sequence_sha256 != sequence_sha256
        || recomputed.ck_contract_id != current_forge_contract_id()
        || recomputed.adapter_id != adapter.id
        || recomputed.engine_contract_id != adapter.engine_contract_id
        || recomputed.artifact_policy_id != adapter.artifact_policy_id
        || recomputed.trial_count < NATIVE_RELINK_REQUIRED_TRIALS
    {
        return None;
    }
    let report = serde_json::from_slice::<serde_json::Value>(&report_bytes).ok()?;
    let target = report.get("target")?;
    let policy = report.get("policy")?;
    let stages = report.get("stages")?.as_array()?;
    if json_string(&report, "schemaId") != Some(NATIVE_RELINK_REPORT_SCHEMA_ID)
        || report.get("schemaVersion")?.as_u64() != Some(1)
        || json_string(&report, "evidenceSha256") != Some(certificate.evidence_sha256.as_str())
        || json_string(&report, "qualificationKey") != Some(recomputed.qualification_key.as_str())
        || json_string(&report, "operation") != Some("compile")
        || json_string(&report, "candidateProfile") != Some(NATIVE_RELINK_PROFILE_ID)
        || json_string(&report, "status") != Some("qualified-native-relink")
        || json_string(&report, "recommendedRoute") != Some(NATIVE_RELINK_PROFILE_ID)
        || !json_true(&report, "qualified")
        || report.get("coldSimpleRequiredToWin")?.as_bool() != Some(false)
        || report.get("trialCountPerLane")?.as_u64()? != recomputed.trial_count as u64
        || json_string(&report, "ckContractId") != Some(current_forge_contract_id())
        || json_string(&report, "nativeRelinkContractId")
            != Some(recomputed.engine_contract_id.as_str())
        || json_string(&report, "nativeRelinkAdapterId") != Some(recomputed.adapter_id.as_str())
        || json_string(&report, "artifactEquivalencePolicyId")
            != Some(recomputed.artifact_policy_id.as_str())
        || json_string(policy, "id") != Some(NATIVE_RELINK_POLICY_ID)
        || json_string(target, "fqbn") != Some(recomputed.fqbn.as_str())
        || json_string(target, "coreVersion") != Some(recomputed.core_version.as_str())
        || json_string(target, "toolchainKey") != Some(recomputed.toolchain_key.as_str())
        || json_string(target, "cliVersion") != Some(recomputed.cli_version.as_str())
        || json_string(target, "cliExecutableSha256")
            != Some(recomputed.cli_executable_sha256.as_str())
        || json_string(target, "hostIdentitySha256")
            != Some(recomputed.host_identity_sha256.as_str())
        || json_string(target, "productionExecutableSha256")
            != Some(recomputed.production_executable_sha256.as_str())
        || json_string(target, "sequenceSha256") != Some(recomputed.sequence_sha256.as_str())
        || stages.len() != NATIVE_RELINK_EDIT_STAGES.len()
        || stages
            .iter()
            .zip(NATIVE_RELINK_EDIT_STAGES)
            .any(|(stage, expected)| {
                json_string(stage, "id") != Some(expected) || !json_true(stage, "qualified")
            })
    {
        return None;
    }
    Some(certificate.evidence_sha256)
}

fn migration_toolchain_key_is_exact(key: &str, platform: &str, core_version: &str) -> bool {
    let Some((package, architecture)) = platform.split_once(':') else {
        return false;
    };
    let mut parts = key.split('|');
    parts.next() == Some(package)
        && parts.next() == Some(architecture)
        && parts.next() == Some(core_version)
        && parts.next().is_some_and(sha256_text_is_valid)
        && parts.next().is_none()
}

fn parse_portable_toolchain_migration_index(raw: &str) -> Option<PortableToolchainMigrationIndex> {
    let index = serde_json::from_str::<PortableToolchainMigrationIndex>(raw).ok()?;
    if index.schema_id != "ck.forge.portable-toolchain-migration"
        || index.schema_version != 1
        || index.identity_schema != CK_FORGE_PORTABLE_TOOLCHAIN_IDENTITY_SCHEMA
        || index.entries.is_empty()
        || index.entries.len() > MAX_PORTABLE_TOOLCHAIN_MIGRATION_ENTRIES
    {
        return None;
    }
    let mut portable_bindings = std::collections::BTreeMap::new();
    let mut evidence_bindings = std::collections::BTreeMap::new();
    for entry in &index.entries {
        let parsed = parse_complete_fqbn(&entry.fqbn)?;
        if parsed.complete != parsed.canonical_fqbn
            || Version::parse(&entry.core_version).is_err()
            || !migration_toolchain_key_is_exact(
                &entry.portable_toolchain_key,
                &parsed.platform,
                &entry.core_version,
            )
            || !migration_toolchain_key_is_exact(
                &entry.evidence_toolchain_key,
                &parsed.platform,
                &entry.core_version,
            )
            || entry.portable_toolchain_key == entry.evidence_toolchain_key
        {
            return None;
        }
        let portable_binding = (
            entry.fqbn.as_str(),
            entry.core_version.as_str(),
            entry.portable_toolchain_key.as_str(),
        );
        if portable_bindings
            .insert(portable_binding, entry.evidence_toolchain_key.as_str())
            .is_some_and(|existing| existing != entry.evidence_toolchain_key.as_str())
        {
            return None;
        }
        let evidence_binding = (
            entry.fqbn.as_str(),
            entry.core_version.as_str(),
            entry.evidence_toolchain_key.as_str(),
        );
        if evidence_bindings
            .insert(evidence_binding, entry.portable_toolchain_key.as_str())
            .is_some_and(|existing| existing != entry.portable_toolchain_key.as_str())
        {
            return None;
        }
    }
    Some(index)
}

fn portable_toolchain_migration_index() -> Option<&'static PortableToolchainMigrationIndex> {
    static INDEX: OnceLock<Option<PortableToolchainMigrationIndex>> = OnceLock::new();
    INDEX
        .get_or_init(|| {
            parse_portable_toolchain_migration_index(CK_FORGE_PORTABLE_TOOLCHAIN_MIGRATION_JSON)
        })
        .as_ref()
}

fn portable_evidence_toolchain_keys(
    fqbn: &str,
    core_version: &str,
    portable_toolchain_key: &str,
) -> Vec<&'static str> {
    let lookup_fqbn = native_relink_default_complete_fqbn(fqbn);
    let Some(parsed) = parse_complete_fqbn(&lookup_fqbn) else {
        return Vec::new();
    };
    let Some(index) = portable_toolchain_migration_index() else {
        return Vec::new();
    };
    let mut keys = index
        .entries
        .iter()
        .filter(|entry| {
            entry.fqbn == parsed.canonical_fqbn
                && entry.core_version == core_version
                && entry.portable_toolchain_key == portable_toolchain_key
        })
        .map(|entry| entry.evidence_toolchain_key.as_str())
        .collect::<Vec<_>>();
    keys.sort_unstable();
    keys.dedup();
    keys
}

/// Return the immutable raw A/B evidence SHA for a matching NativeRelink
/// certificate. User-created certificates are preferred, but a read-only
/// certificate set shipped with CK is also accepted when the user's writable
/// sysroot has no matching row. The bundled set is intentionally portable
/// across user names, home directories and drive letters: the host fingerprint
/// is provenance only in that path. All compiler, Core, CLI, toolchain, target,
/// artifact and performance gates remain exact and fail-closed.
pub fn load_local_native_relink_evidence_sha256(
    sysroot_root: &std::path::Path,
    fqbn: &str,
    core_version: &str,
    cli_version: &str,
    toolchain_key: &str,
) -> Option<String> {
    let local_root = sysroot_root.join("state").join("qualifications");
    if let Some(value) = load_native_relink_evidence_sha256_from_root(
        sysroot_root,
        &local_root,
        fqbn,
        core_version,
        cli_version,
        toolchain_key,
        false,
    ) {
        return Some(value);
    }

    let executable_parent = std::env::current_exe().ok()?.parent()?.to_path_buf();
    // Tauri has used both a flat resource destination and a `resources/`
    // subdirectory across installer targets. Keep all candidates relative to
    // the signed executable; never search arbitrary user or PATH locations.
    let mut bundled_roots = vec![
        executable_parent.join("state").join("qualifications"),
        executable_parent
            .join("resources")
            .join("state")
            .join("qualifications"),
        executable_parent.join("resources").join("qualifications"),
    ];
    if let Some(registered) = BUNDLED_NATIVE_RELINK_ROOTS.get() {
        bundled_roots.extend(registered.iter().cloned());
    }
    let portable_evidence_keys =
        portable_evidence_toolchain_keys(fqbn, core_version, toolchain_key);
    for bundled_root in bundled_roots {
        let same_root = local_root == bundled_root
            || local_root
                .canonicalize()
                .ok()
                .zip(bundled_root.canonicalize().ok())
                .is_some_and(|(local, bundled)| local == bundled);
        if same_root {
            continue;
        }
        if let Some(value) = load_native_relink_evidence_sha256_from_root(
            sysroot_root,
            &bundled_root,
            fqbn,
            core_version,
            cli_version,
            toolchain_key,
            true,
        ) {
            return Some(value);
        }
        // v12 qualification keys accidentally included per-machine package
        // receipts and the global ccache-shim directory. A bundled, immutable
        // v13 mapping may translate only when the current portable strong
        // identity exactly matches the qualified Core, CLI and selected tools.
        // The original evidence remains byte-for-byte unchanged and is still
        // fully revalidated by the loader above.
        for evidence_toolchain_key in &portable_evidence_keys {
            if *evidence_toolchain_key == toolchain_key {
                continue;
            }
            if let Some(value) = load_native_relink_evidence_sha256_from_root(
                sysroot_root,
                &bundled_root,
                fqbn,
                core_version,
                cli_version,
                evidence_toolchain_key,
                true,
            ) {
                return Some(value);
            }
        }
    }
    None
}

/// Load a NativeRelink certificate for a narrowly proven vendor mirror.
///
/// The package manager may label the published ESP32 3.3.6 archive as
/// `3.3.6-cn`.  That label is not accepted as a version alias by the normal
/// loader.  Only a caller that has independently verified the exact archive
/// receipt *and* computed the canonical content identity may request this
/// read-only lookup.  The build itself continues to use the mirror's real
/// paths and raw Core version; this function only selects the already
/// authenticated 3.3.6 evidence record.
pub fn load_local_native_relink_evidence_sha256_with_core_package_identity(
    sysroot_root: &std::path::Path,
    fqbn: &str,
    core_version: &str,
    cli_version: &str,
    toolchain_key: &str,
    core_package_identity: Option<ForgeCorePackageIdentity<'_>>,
    canonical_toolchain_key: Option<&str>,
) -> Option<String> {
    if let Some(value) = load_local_native_relink_evidence_sha256(
        sysroot_root,
        fqbn,
        core_version,
        cli_version,
        toolchain_key,
    ) {
        return Some(value);
    }

    if !core_package_identity_is_known_equivalent(fqbn, core_version, core_package_identity) {
        return None;
    }
    let canonical_toolchain_key = canonical_toolchain_key
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    // This is intentionally a fixed, internal lookup value.  It is reached
    // only after the exact archive proof above and still runs the complete
    // certificate/CLI/toolchain/artifact/policy validation in the base loader.
    load_local_native_relink_evidence_sha256(
        sysroot_root,
        fqbn,
        ESP32_3_3_6_CANONICAL_VERSION,
        cli_version,
        canonical_toolchain_key,
    )
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BuiltinQualificationManifest {
    schema_version: u32,
    engine_id: String,
    contract_id: String,
    arduino_cli_version: String,
    host_os: String,
    host_arch: String,
    targets: Vec<BuiltinQualificationTarget>,
}

pub(crate) fn parse_builtin_qualification_manifest(
    raw: &str,
) -> Option<BuiltinQualificationManifest> {
    let manifest = serde_json::from_str::<BuiltinQualificationManifest>(raw).ok()?;
    if manifest.schema_version != 2
        || manifest.engine_id != "ck-forge/v1"
        || manifest.contract_id != current_forge_contract_id()
        || manifest.arduino_cli_version != CK_FORGE_QUALIFIED_ARDUINO_CLI_VERSION
        || manifest.host_os.trim().is_empty()
        || manifest.host_arch.trim().is_empty()
        || manifest.targets.is_empty()
    {
        return None;
    }
    let mut identities = std::collections::BTreeSet::new();
    for target in &manifest.targets {
        let parsed = parse_complete_fqbn(&target.canonical_fqbn)?;
        if parsed.canonical_fqbn != target.canonical_fqbn
            || Version::parse(&target.core_version).is_err()
            || !identities.insert((target.canonical_fqbn.clone(), target.core_version.clone()))
            || target
                .performance_ab
                .iter()
                .any(|evidence| !performance_ab_passes(evidence))
        {
            return None;
        }
        let mut certified_capabilities = std::collections::BTreeSet::new();
        if target.performance_ab.iter().any(|evidence| {
            !certified_capabilities.insert((evidence.operation, evidence.candidate_profile))
        }) {
            return None;
        }
        let key_parts = target.toolchain_key.split('|').collect::<Vec<_>>();
        let platform_parts = parsed.platform.split(':').collect::<Vec<_>>();
        if key_parts.len() != 4
            || platform_parts.len() != 2
            || key_parts[0] != platform_parts[0]
            || key_parts[1] != platform_parts[1]
            || key_parts[2] != target.core_version
            || key_parts[3].len() != 64
            || !key_parts[3].bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return None;
        }
    }
    Some(manifest)
}

fn builtin_qualification_manifest() -> Option<&'static BuiltinQualificationManifest> {
    static MANIFEST: OnceLock<Option<BuiltinQualificationManifest>> = OnceLock::new();
    MANIFEST
        .get_or_init(|| parse_builtin_qualification_manifest(CK_FORGE_QUALIFICATION_MANIFEST_JSON))
        .as_ref()
}

pub(crate) fn builtin_manifest_matches_host(
    manifest: &BuiltinQualificationManifest,
    host_os: &str,
    host_arch: &str,
) -> bool {
    manifest.host_os == host_os && manifest.host_arch == host_arch
}

fn builtin_manifest_matches_current_host(manifest: &BuiltinQualificationManifest) -> bool {
    builtin_manifest_matches_host(manifest, std::env::consts::OS, std::env::consts::ARCH)
}

/// Current fast-build contract already used by Core, dependency, and exact
/// cache identities. Keeping this as a reference avoids inventing a second
/// contract merely for the CK Forge brand.
pub fn current_forge_contract_id() -> &'static str {
    ck_core::builder::demo::FAST_BUILD_CONTRACT_SIGNATURE_MARKER
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ForgeRouteDecision {
    AllowFast,
    /// Keep the Core's unmodified native Arduino CLI build semantics. This
    /// does not authorize PortableFast, QuickFast/SharedFast, skipped hooks,
    /// compiler shims, or direct linking.
    ForcePlatform,
    /// Reserved for a future deterministic incompatibility gate. CK Forge v1
    /// never returns this merely because a platform or version is unknown.
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ForgeDecisionSource {
    BuiltinMatrix,
    LocalQualification,
    ConservativeFallback,
}

/// Fine-grained profiles authorized by matching performance evidence. This is
/// intentionally additive to `ForgeRouteDecision`: callers must check the
/// exact operation/profile capability instead of treating `AllowFast` as a
/// blanket permission.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeFastCapabilities {
    pub compile_portable_fast: bool,
    pub compile_quick_fast: bool,
    pub compile_native_relink_only: bool,
    pub upload_quick_fast: bool,
    pub upload_shared_fast: bool,
}

impl ForgeFastCapabilities {
    pub fn allows(
        self,
        operation: ForgePerformanceOperation,
        profile: ForgePerformanceProfile,
    ) -> bool {
        match (operation, profile) {
            (ForgePerformanceOperation::Compile, ForgePerformanceProfile::PortableFast) => {
                self.compile_portable_fast
            }
            (ForgePerformanceOperation::Compile, ForgePerformanceProfile::QuickFast) => {
                self.compile_quick_fast
            }
            (ForgePerformanceOperation::Compile, ForgePerformanceProfile::SharedFast) => false,
            (
                ForgePerformanceOperation::Compile,
                ForgePerformanceProfile::NativeRelinkCompileOnly,
            ) => self.compile_native_relink_only,
            (ForgePerformanceOperation::UploadReady, ForgePerformanceProfile::PortableFast) => {
                false
            }
            (ForgePerformanceOperation::UploadReady, ForgePerformanceProfile::QuickFast) => {
                self.upload_quick_fast
            }
            (ForgePerformanceOperation::UploadReady, ForgePerformanceProfile::SharedFast) => {
                self.upload_shared_fast
            }
            (
                ForgePerformanceOperation::UploadReady,
                ForgePerformanceProfile::NativeRelinkCompileOnly,
            ) => false,
        }
    }

    fn grant(&mut self, operation: ForgePerformanceOperation, profile: ForgePerformanceProfile) {
        match (operation, profile) {
            (ForgePerformanceOperation::Compile, ForgePerformanceProfile::PortableFast) => {
                self.compile_portable_fast = true;
            }
            (ForgePerformanceOperation::Compile, ForgePerformanceProfile::QuickFast) => {
                self.compile_quick_fast = true;
            }
            (ForgePerformanceOperation::Compile, ForgePerformanceProfile::SharedFast) => {}
            (
                ForgePerformanceOperation::Compile,
                ForgePerformanceProfile::NativeRelinkCompileOnly,
            ) => {
                self.compile_native_relink_only = true;
            }
            (ForgePerformanceOperation::UploadReady, ForgePerformanceProfile::PortableFast) => {}
            (ForgePerformanceOperation::UploadReady, ForgePerformanceProfile::QuickFast) => {
                self.upload_quick_fast = true;
            }
            (ForgePerformanceOperation::UploadReady, ForgePerformanceProfile::SharedFast) => {
                self.upload_shared_fast = true;
            }
            (
                ForgePerformanceOperation::UploadReady,
                ForgePerformanceProfile::NativeRelinkCompileOnly,
            ) => {}
        }
    }

    pub fn any(self) -> bool {
        self.compile_portable_fast
            || self.compile_quick_fast
            || self.compile_native_relink_only
            || self.upload_quick_fast
            || self.upload_shared_fast
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ForgeReasonCode {
    BuiltinPlatformCoreQualified,
    BuiltinToolchainIdentityUnavailable,
    BuiltinToolchainContentMismatch,
    BuiltinPerformanceQualificationMissing,
    BuiltinHostIdentityUnavailable,
    BuiltinHostIdentityMismatch,
    UnverifiedBoardConfiguration,
    UnverifiedHostPlatform,
    UnverifiedForgeContract,
    UnverifiedCliVersion,
    LocalQualificationMatched,
    MalformedFqbn,
    MissingCoreVersion,
    InvalidCoreVersion,
    UnknownPlatform,
    UnverifiedBoardTarget,
    UnverifiedCoreVersion,
    QualificationNotPassed,
    QualificationFqbnMismatch,
    QualificationCoreVersionMismatch,
    QualificationCliVersionUnavailable,
    QualificationCliVersionMismatch,
    QualificationContractMismatch,
    QualificationToolchainUnavailable,
    QualificationToolchainMismatch,
    QualificationHostIdentityUnavailable,
    QualificationHostIdentityMismatch,
    QualificationPerformanceUnavailable,
    QualificationPerformanceRegression,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgeQualificationStatus {
    Passed,
    Failed,
    Expired,
}

/// Evidence produced by a local qualification workflow.
///
/// The evidence is intentionally bound to a complete FQBN, Core version,
/// actual toolchain identity, and the fast-build contract. A publisher's
/// manifest declaration alone must not be converted into `Passed` evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeQualificationEvidence {
    pub status: ForgeQualificationStatus,
    pub canonical_fqbn: String,
    pub core_version: String,
    pub cli_version: String,
    pub toolchain_key: String,
    pub contract_id: String,
    pub performance_ab: Vec<ForgePerformanceEvidence>,
}

/// Read-only package provenance used only to decide whether a vendor-suffixed
/// Core folder may be compared with an existing built-in Core row.  This is
/// not persisted qualification evidence and cannot authorize Fast by itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForgeCorePackageIdentity<'a> {
    pub archive_sha256: &'a str,
    pub archive_size: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct ForgeCompatibilityInput<'a> {
    /// Complete Arduino FQBN, including all selected menu options.
    pub fqbn: &'a str,
    /// Currently installed/resolved platform version.
    pub core_version: Option<&'a str>,
    /// Actual Arduino CLI version output. The built-in matrix accepts only the
    /// release used by its qualification evidence when this value is present.
    pub cli_version: Option<&'a str>,
    /// Current strong toolchain identity. It is required when local evidence
    /// (rather than the built-in matrix) is used to unlock fast routing.
    pub toolchain_key: Option<&'a str>,
    /// Current machine/sysroot fingerprint. Required before any performance
    /// certificate may grant a fast capability.
    pub host_identity_sha256: Option<&'a str>,
    pub qualification: Option<&'a ForgeQualificationEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeEngineIdentity {
    pub id: String,
    pub schema_version: u32,
    pub product_version: String,
    pub contract_id: String,
}

impl Default for ForgeEngineIdentity {
    fn default() -> Self {
        Self {
            id: CK_FORGE_ENGINE_ID.to_string(),
            schema_version: CK_FORGE_SCHEMA_VERSION,
            product_version: CK_FORGE_PRODUCT_VERSION.to_string(),
            contract_id: current_forge_contract_id().to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeCompatibilityDecision {
    pub engine: ForgeEngineIdentity,
    pub decision: ForgeRouteDecision,
    pub source: ForgeDecisionSource,
    /// Trimmed complete target retained for diagnostics and evidence binding.
    pub fqbn: String,
    /// `package:architecture`, only present for a well-formed FQBN.
    pub platform: Option<String>,
    pub core_version: Option<String>,
    pub capabilities: ForgeFastCapabilities,
    pub reason_codes: Vec<ForgeReasonCode>,
}

impl ForgeCompatibilityDecision {
    pub fn allows(
        &self,
        operation: ForgePerformanceOperation,
        profile: ForgePerformanceProfile,
    ) -> bool {
        self.decision == ForgeRouteDecision::AllowFast
            && self.capabilities.allows(operation, profile)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedFqbn<'a> {
    complete: &'a str,
    platform: String,
    base_fqbn: String,
    canonical_fqbn: String,
}

fn valid_fqbn_token(value: &str) -> bool {
    !value.is_empty()
        && !value
            .chars()
            .any(|character| character.is_whitespace() || matches!(character, ':' | ',' | '='))
}

fn parse_complete_fqbn(raw: &str) -> Option<ParsedFqbn<'_>> {
    let complete = raw.trim();
    let mut parts = complete.splitn(4, ':');
    let package = parts.next()?.trim();
    let architecture = parts.next()?.trim();
    let board = parts.next()?.trim();
    if !valid_fqbn_token(package) || !valid_fqbn_token(architecture) || !valid_fqbn_token(board) {
        return None;
    }
    let base_fqbn = format!("{package}:{architecture}:{board}");
    let mut canonical_fqbn = base_fqbn.clone();
    if let Some(options) = parts.next() {
        if options.trim().is_empty() {
            return None;
        }
        let mut parsed_options = Vec::new();
        for entry in options.split(',') {
            let (key, value) = entry.trim().split_once('=')?;
            let key = key.trim();
            let value = value.trim();
            if !valid_fqbn_token(key) || !valid_fqbn_token(value) {
                return None;
            }
            parsed_options.push((key.to_ascii_lowercase(), key.to_string(), value.to_string()));
        }
        parsed_options.sort_by(|left, right| left.0.cmp(&right.0).then(left.2.cmp(&right.2)));
        if parsed_options.windows(2).any(|pair| pair[0].0 == pair[1].0) {
            return None;
        }
        canonical_fqbn.push(':');
        canonical_fqbn.push_str(
            &parsed_options
                .into_iter()
                .map(|(_, key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    Some(ParsedFqbn {
        complete,
        platform: format!("{package}:{architecture}"),
        base_fqbn,
        canonical_fqbn,
    })
}

fn performance_capabilities(
    evidence: &[ForgePerformanceEvidence],
    current_host_identity: &str,
) -> ForgeFastCapabilities {
    let mut capabilities = ForgeFastCapabilities::default();
    if !sha256_text_is_valid(current_host_identity) {
        return capabilities;
    }
    for item in evidence.iter().filter(|item| {
        performance_ab_passes(item) && item.host_identity_sha256 == current_host_identity
    }) {
        capabilities.grant(item.operation, item.candidate_profile);
    }
    capabilities
}

/// Return the manifest lookup version only when the current package receipt
/// proves the exact known archive bytes.  The raw version remains untouched in
/// diagnostics/evidence bindings.  This deliberately does not compare a
/// toolchain key or grant any capability; those checks stay in the normal
/// authorization path and therefore reject a CN installation whose tools or
/// Core contents differ from the qualified target.
fn builtin_lookup_version_for_core_identity(
    parsed: &ParsedFqbn<'_>,
    raw_version: &str,
    identity: Option<ForgeCorePackageIdentity<'_>>,
) -> Option<Version> {
    if parsed.platform != "esp32:esp32"
        || raw_version != ESP32_3_3_6_CN_VERSION
        || !identity.is_some_and(|identity| {
            identity.archive_size == ESP32_3_3_6_ARCHIVE_SIZE
                && identity.archive_sha256.trim() == ESP32_3_3_6_ARCHIVE_SHA256
        })
    {
        return None;
    }
    Version::parse(ESP32_3_3_6_CANONICAL_VERSION).ok()
}

/// Expose the strict, denial-first mirror check to the desktop package
/// resolver without exposing the built-in manifest internals.  `true` means
/// only that the package receipt identifies the same published archive; the
/// caller must still pass the ordinary Forge toolchain and A/B gates.
pub fn core_package_identity_is_known_equivalent(
    fqbn: &str,
    core_version: &str,
    identity: Option<ForgeCorePackageIdentity<'_>>,
) -> bool {
    parse_complete_fqbn(fqbn).is_some_and(|parsed| {
        builtin_lookup_version_for_core_identity(&parsed, core_version.trim(), identity).is_some()
    })
}

fn builtin_target_capabilities(
    canonical_fqbn: &str,
    version: &Version,
    current_host_identity: &str,
) -> ForgeFastCapabilities {
    if !version.pre.is_empty() || !version.build.is_empty() {
        return ForgeFastCapabilities::default();
    }
    let Some(manifest) = builtin_qualification_manifest()
        .filter(|manifest| builtin_manifest_matches_current_host(manifest))
    else {
        return ForgeFastCapabilities::default();
    };
    manifest
        .targets
        .iter()
        .find(|target| {
            target.canonical_fqbn == canonical_fqbn
                && Version::parse(&target.core_version).ok().as_ref() == Some(version)
        })
        .map(|target| performance_capabilities(&target.performance_ab, current_host_identity))
        .unwrap_or_default()
}

fn builtin_target_identity_is_listed(canonical_fqbn: &str, version: &Version) -> bool {
    if !version.pre.is_empty() || !version.build.is_empty() {
        return false;
    }
    builtin_qualification_manifest().is_some_and(|manifest| {
        manifest.targets.iter().any(|target| {
            target.canonical_fqbn == canonical_fqbn
                && Version::parse(&target.core_version).ok().as_ref() == Some(version)
        })
    })
}

fn builtin_target_has_performance_evidence(canonical_fqbn: &str, version: &Version) -> bool {
    builtin_qualification_manifest().is_some_and(|manifest| {
        manifest.targets.iter().any(|target| {
            target.canonical_fqbn == canonical_fqbn
                && Version::parse(&target.core_version).ok().as_ref() == Some(version)
                && !target.performance_ab.is_empty()
        })
    })
}

fn builtin_target_exists_for_another_host(canonical_fqbn: &str, version: &Version) -> bool {
    builtin_qualification_manifest().is_some_and(|manifest| {
        !builtin_manifest_matches_current_host(manifest)
            && manifest.targets.iter().any(|target| {
                target.canonical_fqbn == canonical_fqbn
                    && Version::parse(&target.core_version).ok().as_ref() == Some(version)
            })
    })
}

fn builtin_base_board_is_known(base_fqbn: &str, version: &Version) -> bool {
    if !version.pre.is_empty() || !version.build.is_empty() {
        return false;
    }
    builtin_qualification_manifest().is_some_and(|manifest| {
        manifest.targets.iter().any(|target| {
            parse_complete_fqbn(&target.canonical_fqbn).is_some_and(|parsed| {
                parsed.base_fqbn == base_fqbn
                    && Version::parse(&target.core_version).ok().as_ref() == Some(version)
            })
        })
    })
}

fn qualified_cli_version(actual: &str) -> bool {
    let actual = actual.trim();
    let version_token = if actual == CK_FORGE_QUALIFIED_ARDUINO_CLI_VERSION {
        Some(actual)
    } else {
        let tokens = actual.split_whitespace().collect::<Vec<_>>();
        tokens.windows(2).find_map(|pair| {
            pair[0]
                .trim_end_matches(':')
                .eq_ignore_ascii_case("version")
                .then_some(pair[1].trim_matches(|character: char| {
                    !character.is_ascii_alphanumeric() && character != '.' && character != '-'
                }))
        })
    };
    let expected = builtin_qualification_manifest()
        .map(|manifest| manifest.arduino_cli_version.as_str())
        .unwrap_or(CK_FORGE_QUALIFIED_ARDUINO_CLI_VERSION);
    version_token
        .and_then(|value| Version::parse(value).ok())
        .is_some_and(|version| Version::parse(expected).ok().as_ref() == Some(&version))
}

fn builtin_platform_version_is_known(platform: &str, version: &Version) -> bool {
    version.pre.is_empty()
        && version.build.is_empty()
        && builtin_qualification_manifest().is_some_and(|manifest| {
            manifest.targets.iter().any(|target| {
                parse_complete_fqbn(&target.canonical_fqbn).is_some_and(|parsed| {
                    parsed.platform == platform
                        && Version::parse(&target.core_version).ok().as_ref() == Some(version)
                })
            })
        })
}

/// Lightweight enqueue predicate only. This does not grant a fast route: the
/// worker must still call `decide_forge_compatibility` with the real CLI and
/// strong toolchain identity before compiling anything.
pub fn is_builtin_forge_candidate(
    fqbn: &str,
    core_version: Option<&str>,
    host_identity_sha256: Option<&str>,
) -> bool {
    let Some(parsed) = parse_complete_fqbn(fqbn) else {
        return false;
    };
    let Some(version) = core_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| Version::parse(value).ok())
    else {
        return false;
    };
    let Some(host_identity) = host_identity_sha256
        .map(str::trim)
        .filter(|value| sha256_text_is_valid(value))
    else {
        return false;
    };
    builtin_qualification_manifest().is_some_and(|manifest| {
        builtin_manifest_matches_current_host(manifest)
            && current_forge_contract_id() == manifest.contract_id
    }) && builtin_target_capabilities(&parsed.canonical_fqbn, &version, host_identity).any()
}

fn builtin_manifest_toolchain_key(canonical_fqbn: &str, version: &Version) -> Option<&'static str> {
    let manifest = builtin_qualification_manifest()?;
    manifest
        .targets
        .iter()
        .find(|target| {
            target.canonical_fqbn == canonical_fqbn
                && Version::parse(&target.core_version).ok().as_ref() == Some(version)
        })
        .map(|target| target.toolchain_key.as_str())
}

fn builtin_toolchain_key(canonical_fqbn: &str, version: &Version) -> Option<&'static str> {
    let manifest = builtin_qualification_manifest()?;
    if !builtin_manifest_matches_current_host(manifest) {
        return None;
    }
    builtin_manifest_toolchain_key(canonical_fqbn, version)
}

pub(crate) fn builtin_expected_toolchain_key(
    fqbn: &str,
    core_version: &str,
) -> Option<&'static str> {
    let parsed = parse_complete_fqbn(fqbn)?;
    let version = Version::parse(core_version.trim()).ok()?;
    builtin_manifest_toolchain_key(&parsed.canonical_fqbn, &version)
}

fn evidence_mismatch_reasons(
    parsed: &ParsedFqbn<'_>,
    core_version: &str,
    cli_version: Option<&str>,
    toolchain_key: Option<&str>,
    host_identity_sha256: Option<&str>,
    evidence: &ForgeQualificationEvidence,
) -> (Vec<ForgeReasonCode>, ForgeFastCapabilities) {
    let mut reasons = Vec::new();
    if evidence.status != ForgeQualificationStatus::Passed {
        reasons.push(ForgeReasonCode::QualificationNotPassed);
    }
    if evidence.canonical_fqbn.trim() != parsed.canonical_fqbn {
        reasons.push(ForgeReasonCode::QualificationFqbnMismatch);
    }
    if evidence.core_version.trim() != core_version {
        reasons.push(ForgeReasonCode::QualificationCoreVersionMismatch);
    }
    match cli_version.map(str::trim).filter(|value| !value.is_empty()) {
        None => reasons.push(ForgeReasonCode::QualificationCliVersionUnavailable),
        Some(current) if evidence.cli_version.trim() != current => {
            reasons.push(ForgeReasonCode::QualificationCliVersionMismatch);
        }
        Some(_) => {}
    }
    if evidence.contract_id.trim() != current_forge_contract_id() {
        reasons.push(ForgeReasonCode::QualificationContractMismatch);
    }
    match toolchain_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        None => reasons.push(ForgeReasonCode::QualificationToolchainUnavailable),
        Some(current) if evidence.toolchain_key.trim() != current => {
            reasons.push(ForgeReasonCode::QualificationToolchainMismatch);
        }
        Some(_) => {}
    }
    if evidence.performance_ab.is_empty() {
        reasons.push(ForgeReasonCode::QualificationPerformanceUnavailable);
        return (reasons, ForgeFastCapabilities::default());
    }
    let mut unique = std::collections::BTreeSet::new();
    if evidence.performance_ab.iter().any(|performance| {
        !performance_ab_passes(performance)
            || !unique.insert((performance.operation, performance.candidate_profile))
    }) {
        reasons.push(ForgeReasonCode::QualificationPerformanceRegression);
        return (reasons, ForgeFastCapabilities::default());
    }
    let Some(host_identity) = host_identity_sha256
        .map(str::trim)
        .filter(|value| sha256_text_is_valid(value))
    else {
        reasons.push(ForgeReasonCode::QualificationHostIdentityUnavailable);
        return (reasons, ForgeFastCapabilities::default());
    };
    let capabilities = performance_capabilities(&evidence.performance_ab, host_identity);
    if !capabilities.any() {
        reasons.push(ForgeReasonCode::QualificationHostIdentityMismatch);
    }
    (reasons, capabilities)
}

/// Decide whether CK Forge may use the specialized PortableFast/QuickFast/SharedFast
/// profiles for one exact target. Unknown, newer, or merely
/// correctness-qualified versions always take the unmodified platform-native
/// Release lane. They are not blocked.
pub fn decide_forge_compatibility(
    input: ForgeCompatibilityInput<'_>,
) -> ForgeCompatibilityDecision {
    decide_forge_compatibility_with_core_package_identity(input, None)
}

/// Variant of [`decide_forge_compatibility`] used by the managed package
/// resolver when it has a bounded, package-manager archive receipt.  The
/// proof is intentionally an argument rather than a field in the persisted
/// Forge input/certificate shapes, so existing callers remain exact-version
/// fail-closed by default.
pub fn decide_forge_compatibility_with_core_package_identity(
    input: ForgeCompatibilityInput<'_>,
    core_package_identity: Option<ForgeCorePackageIdentity<'_>>,
) -> ForgeCompatibilityDecision {
    let engine = ForgeEngineIdentity::default();
    let fqbn = input.fqbn.trim().to_string();
    let Some(parsed) = parse_complete_fqbn(input.fqbn) else {
        return ForgeCompatibilityDecision {
            engine,
            decision: ForgeRouteDecision::ForcePlatform,
            source: ForgeDecisionSource::ConservativeFallback,
            fqbn,
            platform: None,
            core_version: input.core_version.map(str::trim).map(str::to_string),
            capabilities: ForgeFastCapabilities::default(),
            reason_codes: vec![ForgeReasonCode::MalformedFqbn],
        };
    };

    let platform = Some(parsed.platform.clone());
    let Some(core_version) = input
        .core_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return ForgeCompatibilityDecision {
            engine,
            decision: ForgeRouteDecision::ForcePlatform,
            source: ForgeDecisionSource::ConservativeFallback,
            fqbn,
            platform,
            core_version: None,
            capabilities: ForgeFastCapabilities::default(),
            reason_codes: vec![ForgeReasonCode::MissingCoreVersion],
        };
    };
    let parsed_version = match Version::parse(core_version) {
        Ok(version) => version,
        Err(_) => {
            return ForgeCompatibilityDecision {
                engine,
                decision: ForgeRouteDecision::ForcePlatform,
                source: ForgeDecisionSource::ConservativeFallback,
                fqbn,
                platform,
                core_version: Some(core_version.to_string()),
                capabilities: ForgeFastCapabilities::default(),
                reason_codes: vec![ForgeReasonCode::InvalidCoreVersion],
            };
        }
    };
    let builtin_lookup_version =
        builtin_lookup_version_for_core_identity(&parsed, core_version, core_package_identity)
            .unwrap_or_else(|| parsed_version.clone());

    let current_host_identity = input
        .host_identity_sha256
        .map(str::trim)
        .filter(|value| sha256_text_is_valid(value));
    let builtin_capabilities = current_host_identity
        .map(|host| {
            builtin_target_capabilities(&parsed.canonical_fqbn, &builtin_lookup_version, host)
        })
        .unwrap_or_default();
    if builtin_capabilities.any() {
        let Some(manifest) = builtin_qualification_manifest() else {
            return ForgeCompatibilityDecision {
                engine,
                decision: ForgeRouteDecision::ForcePlatform,
                source: ForgeDecisionSource::ConservativeFallback,
                fqbn,
                platform,
                core_version: Some(core_version.to_string()),
                capabilities: ForgeFastCapabilities::default(),
                reason_codes: vec![ForgeReasonCode::UnverifiedForgeContract],
            };
        };
        if current_forge_contract_id() != manifest.contract_id {
            return ForgeCompatibilityDecision {
                engine,
                decision: ForgeRouteDecision::ForcePlatform,
                source: ForgeDecisionSource::ConservativeFallback,
                fqbn,
                platform,
                core_version: Some(core_version.to_string()),
                capabilities: ForgeFastCapabilities::default(),
                reason_codes: vec![ForgeReasonCode::UnverifiedForgeContract],
            };
        }
        let Some(cli_version) = input
            .cli_version
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return ForgeCompatibilityDecision {
                engine,
                decision: ForgeRouteDecision::ForcePlatform,
                source: ForgeDecisionSource::ConservativeFallback,
                fqbn,
                platform,
                core_version: Some(core_version.to_string()),
                capabilities: ForgeFastCapabilities::default(),
                reason_codes: vec![ForgeReasonCode::UnverifiedCliVersion],
            };
        };
        if !qualified_cli_version(cli_version) {
            return ForgeCompatibilityDecision {
                engine,
                decision: ForgeRouteDecision::ForcePlatform,
                source: ForgeDecisionSource::ConservativeFallback,
                fqbn,
                platform,
                core_version: Some(core_version.to_string()),
                capabilities: ForgeFastCapabilities::default(),
                reason_codes: vec![ForgeReasonCode::UnverifiedCliVersion],
            };
        }
        let Some(actual_toolchain) = input
            .toolchain_key
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return ForgeCompatibilityDecision {
                engine,
                decision: ForgeRouteDecision::ForcePlatform,
                source: ForgeDecisionSource::ConservativeFallback,
                fqbn,
                platform,
                core_version: Some(core_version.to_string()),
                capabilities: ForgeFastCapabilities::default(),
                reason_codes: vec![ForgeReasonCode::BuiltinToolchainIdentityUnavailable],
            };
        };
        let Some(expected_toolchain) =
            builtin_toolchain_key(&parsed.canonical_fqbn, &builtin_lookup_version)
        else {
            return ForgeCompatibilityDecision {
                engine,
                decision: ForgeRouteDecision::ForcePlatform,
                source: ForgeDecisionSource::ConservativeFallback,
                fqbn,
                platform,
                core_version: Some(core_version.to_string()),
                capabilities: ForgeFastCapabilities::default(),
                reason_codes: vec![ForgeReasonCode::BuiltinToolchainIdentityUnavailable],
            };
        };
        if actual_toolchain != expected_toolchain {
            return ForgeCompatibilityDecision {
                engine,
                decision: ForgeRouteDecision::ForcePlatform,
                source: ForgeDecisionSource::ConservativeFallback,
                fqbn,
                platform,
                core_version: Some(core_version.to_string()),
                capabilities: ForgeFastCapabilities::default(),
                reason_codes: vec![ForgeReasonCode::BuiltinToolchainContentMismatch],
            };
        }
        return ForgeCompatibilityDecision {
            engine,
            decision: ForgeRouteDecision::AllowFast,
            source: ForgeDecisionSource::BuiltinMatrix,
            fqbn,
            platform,
            core_version: Some(core_version.to_string()),
            capabilities: builtin_capabilities,
            reason_codes: vec![ForgeReasonCode::BuiltinPlatformCoreQualified],
        };
    }

    if let Some(evidence) = input.qualification {
        let (reasons, capabilities) = evidence_mismatch_reasons(
            &parsed,
            core_version,
            input.cli_version,
            input.toolchain_key,
            input.host_identity_sha256,
            evidence,
        );
        if reasons.is_empty() {
            return ForgeCompatibilityDecision {
                engine,
                decision: ForgeRouteDecision::AllowFast,
                source: ForgeDecisionSource::LocalQualification,
                fqbn,
                platform,
                core_version: Some(core_version.to_string()),
                capabilities,
                reason_codes: vec![ForgeReasonCode::LocalQualificationMatched],
            };
        }
        return ForgeCompatibilityDecision {
            engine,
            decision: ForgeRouteDecision::ForcePlatform,
            source: ForgeDecisionSource::ConservativeFallback,
            fqbn,
            platform,
            core_version: Some(core_version.to_string()),
            capabilities: ForgeFastCapabilities::default(),
            reason_codes: reasons,
        };
    }

    let reason = if builtin_target_exists_for_another_host(
        &parsed.canonical_fqbn,
        &builtin_lookup_version,
    ) {
        ForgeReasonCode::UnverifiedHostPlatform
    } else if builtin_target_identity_is_listed(&parsed.canonical_fqbn, &builtin_lookup_version) {
        if builtin_target_has_performance_evidence(&parsed.canonical_fqbn, &builtin_lookup_version)
        {
            if current_host_identity.is_none() {
                ForgeReasonCode::BuiltinHostIdentityUnavailable
            } else {
                ForgeReasonCode::BuiltinHostIdentityMismatch
            }
        } else {
            ForgeReasonCode::BuiltinPerformanceQualificationMissing
        }
    } else if builtin_base_board_is_known(&parsed.base_fqbn, &builtin_lookup_version) {
        ForgeReasonCode::UnverifiedBoardConfiguration
    } else if builtin_platform_version_is_known(&parsed.platform, &builtin_lookup_version) {
        ForgeReasonCode::UnverifiedBoardTarget
    } else if matches!(
        parsed.platform.as_str(),
        "esp32:esp32" | "arduino:avr" | "esp8266:esp8266"
    ) {
        ForgeReasonCode::UnverifiedCoreVersion
    } else {
        ForgeReasonCode::UnknownPlatform
    };
    ForgeCompatibilityDecision {
        engine,
        decision: ForgeRouteDecision::ForcePlatform,
        source: ForgeDecisionSource::ConservativeFallback,
        fqbn,
        platform,
        core_version: Some(core_version.to_string()),
        capabilities: ForgeFastCapabilities::default(),
        reason_codes: vec![reason],
    }
}

#[cfg(test)]
mod native_relink_binding_contract_tests {
    use super::{
        AVR_NATIVE_RELINK_ADAPTER, CK_FORGE_NATIVE_RELINK_COMPILE_ONLY_CONTRACT_ID,
        COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID, ESP32C6_NATIVE_RELINK_ADAPTER,
        ForgePerformanceEvidence, ForgePerformanceOperation, ForgePerformanceProfile,
        ForgeQualificationProbe, GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
        LOCAL_QUALIFICATION_SCHEMA_ID, MAX_LOCAL_QUALIFICATION_HINT_SCAN,
        NATIVE_RELINK_BINDING_SCHEMA_VERSION, NATIVE_RELINK_POLICY_ID, NATIVE_RELINK_PROFILE_ID,
        NATIVE_RELINK_REPORT_SCHEMA_ID, NATIVE_RELINK_RUN_SCHEMA_ID, NativeRelinkHintScan,
        PERFORMANCE_POLICY_ID, PORTABLE_EDIT_STAGES,
        PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID, PORTABLE_FAST_RECIPE_INTENT,
        artifact_role_matches, candidate_artifact_content_multiset, canonical_json,
        ck_run_execution_is_qualification_safe, ck_run_route_is_valid,
        compile_only_application_artifacts_equivalent, compute_qualification_key,
        compute_qualification_key_with_policy, current_forge_contract_id,
        current_production_executable_sha256, exact_local_qualification_directory,
        fast_artifact_equivalence_policy_id, generic_run_artifacts_equivalent,
        host_environment_fingerprint, load_local_native_relink_evidence_sha256,
        load_local_qualification, managed_cli_executable_sha256,
        may_contain_local_performance_certificate, may_contain_native_relink_target,
        native_artifact_set_sha256, native_relink_adapter_contract_matches,
        native_relink_adapter_for, native_relink_default_complete_fqbn,
        native_relink_qualification_key, native_relink_qualification_key_for_adapter,
        native_run_integrity_projection, optional_artifact_role_matches,
        parse_portable_toolchain_migration_index, performance_ab_passes, performance_capabilities,
        portable_edit_sequence_sha256, portable_evidence_toolchain_keys,
        portable_fast_run_artifacts_equivalent, qualification_cli_file_reads,
        register_managed_cli_executable_identity, remove_managed_cli_executable_identity,
        reset_qualification_cli_file_reads, run_artifact_set_is_bound, scan_native_relink_hints,
        sha256_bytes, validate_artifact_set, validated_operation_profile,
        witness_artifact_role_matches,
    };

    const TEST_FQBN: &str = "arduino:avr:uno";
    const TEST_CORE_VERSION: &str = "1.8.6";
    const TEST_CLI_VERSION: &str =
        "arduino-cli  Version: 1.4.1 Commit: test Date: 2026-07-20T00:00:00Z";
    const TEST_TOOLCHAIN_KEY: &str = "arduino|avr|1.8.6|fixture-toolchain";

    #[test]
    fn startup_verified_cli_digest_is_reused_and_file_change_revokes_it() {
        let root = std::env::temp_dir().join(format!(
            "ck-forge-cli-identity-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("test root");
        let cli = root.join("arduino-cli.exe");
        std::fs::write(&cli, b"startup-verified-cli").expect("test CLI");
        let initial = sha256_bytes(b"startup-verified-cli");
        register_managed_cli_executable_identity(&cli, &initial)
            .expect("register startup identity");

        reset_qualification_cli_file_reads();
        assert_eq!(
            managed_cli_executable_sha256(&cli, 1024).as_deref(),
            Some(initial.as_str())
        );
        assert_eq!(qualification_cli_file_reads(), 0);

        #[cfg(windows)]
        assert!(
            std::fs::write(&cli, b"changed-managed-cli-bytes").is_err(),
            "the cached executable identity must hold a read-only mutation lock"
        );
        remove_managed_cli_executable_identity(&cli);
        std::fs::write(&cli, b"changed-managed-cli-bytes").expect("mutate test CLI after revoke");
        let changed = sha256_bytes(b"changed-managed-cli-bytes");
        assert_eq!(
            managed_cli_executable_sha256(&cli, 1024).as_deref(),
            Some(changed.as_str())
        );
        assert_eq!(qualification_cli_file_reads(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    fn portable_migration_index_json(entries: serde_json::Value) -> String {
        serde_json::to_string(&serde_json::json!({
            "schemaId": "ck.forge.portable-toolchain-migration",
            "schemaVersion": 1,
            "identitySchema": "ck_toolchain_cache_key_v13_portable_inputs",
            "entries": entries
        }))
        .expect("migration fixture JSON")
    }

    #[test]
    fn portable_toolchain_migration_is_exact_and_fails_closed() {
        let portable = format!("arduino|avr|1.8.6|{}", "a".repeat(64));
        let legacy = format!("arduino|avr|1.8.6|{}", "b".repeat(64));
        let valid = portable_migration_index_json(serde_json::json!([{
            "fqbn": "arduino:avr:nano:cpu=atmega328",
            "coreVersion": "1.8.6",
            "portableToolchainKey": portable,
            "evidenceToolchainKey": legacy
        }]));
        let parsed = parse_portable_toolchain_migration_index(&valid)
            .expect("valid portable migration index");
        assert_eq!(parsed.entries.len(), 1);

        for unknown in [
            format!("arduino|avr|1.8.6|{}", "c".repeat(64)),
            format!("arduino|avr|1.8.7|{}", "a".repeat(64)),
        ] {
            assert!(
                parsed.entries.iter().all(|entry| {
                    entry.fqbn != "arduino:avr:nano:cpu=atmega328"
                        || entry.core_version != "1.8.6"
                        || entry.portable_toolchain_key != unknown
                }),
                "an unknown portable identity must not map to legacy evidence"
            );
        }

        let wrong_fqbn = valid.replace("arduino:avr:nano:cpu=atmega328", "esp32:esp32:esp32c6");
        assert!(parse_portable_toolchain_migration_index(&wrong_fqbn).is_none());
        let malformed_key = valid.replace(
            &format!("arduino|avr|1.8.6|{}", "a".repeat(64)),
            "arduino|avr|1.8.6|not-a-sha256",
        );
        assert!(parse_portable_toolchain_migration_index(&malformed_key).is_none());
        let same_key = valid.replace(
            &format!("arduino|avr|1.8.6|{}", "b".repeat(64)),
            &format!("arduino|avr|1.8.6|{}", "a".repeat(64)),
        );
        assert!(parse_portable_toolchain_migration_index(&same_key).is_none());

        // The shipped index must remain valid and an unlisted identity returns
        // no evidence key, rather than falling back to any sibling board row.
        assert!(super::portable_toolchain_migration_index().is_some());
        assert!(
            portable_evidence_toolchain_keys(
                "arduino:avr:nano:cpu=atmega328",
                "1.8.6",
                &format!("arduino|avr|1.8.6|{}", "f".repeat(64)),
            )
            .is_empty()
        );
    }

    #[test]
    fn shipped_portable_migration_covers_every_bundled_certificate_and_avr_defaults() {
        let index = super::portable_toolchain_migration_index().expect("shipped migration index");
        assert_eq!(index.entries.len(), 69);
        for entry in &index.entries {
            assert!(
                portable_evidence_toolchain_keys(
                    &entry.fqbn,
                    &entry.core_version,
                    &entry.portable_toolchain_key,
                )
                .contains(&entry.evidence_toolchain_key.as_str()),
                "missing migrated certificate binding for {}",
                entry.fqbn
            );
        }

        let nano = index
            .entries
            .iter()
            .find(|entry| entry.fqbn == "arduino:avr:nano:cpu=atmega328")
            .expect("Nano default migration row");
        assert!(
            portable_evidence_toolchain_keys(
                "arduino:avr:nano",
                "1.8.6",
                &nano.portable_toolchain_key,
            )
            .contains(&nano.evidence_toolchain_key.as_str()),
            "the board picker base FQBN must resolve to Nano's default CPU certificate"
        );
    }

    fn write_test_cli(sysroot: &std::path::Path) -> String {
        let cli_path = if cfg!(windows) {
            sysroot.join("bin/arduino-cli.exe")
        } else {
            sysroot.join("bin/arduino-cli")
        };
        std::fs::create_dir_all(cli_path.parent().expect("CLI parent"))
            .expect("create CLI directory");
        let bytes = b"bounded native-relink CLI fixture";
        std::fs::write(&cli_path, bytes).expect("write CLI fixture");
        sha256_bytes(bytes)
    }

    #[test]
    fn avr_base_targets_use_only_their_core_default_cpu_for_certificate_lookup() {
        assert_eq!(
            native_relink_default_complete_fqbn("arduino:avr:diecimila"),
            "arduino:avr:diecimila:cpu=atmega328"
        );
        assert_eq!(
            native_relink_default_complete_fqbn("arduino:avr:nano"),
            "arduino:avr:nano:cpu=atmega328"
        );
        assert_eq!(
            native_relink_default_complete_fqbn("arduino:avr:mega"),
            "arduino:avr:mega:cpu=atmega2560"
        );
        assert_eq!(
            native_relink_default_complete_fqbn("arduino:avr:diecimila:cpu=atmega168"),
            "arduino:avr:diecimila:cpu=atmega168"
        );
        assert_eq!(
            native_relink_default_complete_fqbn("esp32:esp32:esp32c6"),
            "esp32:esp32:esp32c6"
        );
    }

    #[test]
    fn generic_performance_runs_require_token_bound_fast_execution() {
        let run = |build_mode: &str, fallback_used: bool| {
            serde_json::json!({
                "candidateRoute": "qualification-token-probe",
                "buildMode": build_mode,
                "fallbackUsed": fallback_used,
            })
        };
        let quick_fast_safe = |run: &serde_json::Value, stage| {
            ck_run_execution_is_qualification_safe(run, stage, ForgePerformanceProfile::QuickFast)
        };

        assert!(quick_fast_safe(&run("full-build", false), "simple"));
        assert!(quick_fast_safe(&run("fast-relink", false), "simple"));
        for stage in ["complex", "medium", "simple-return"] {
            assert!(quick_fast_safe(&run("fast-relink", false), stage));
            assert!(
                !quick_fast_safe(&run("full-build", false), stage),
                "{stage} must prove Fast Relink rather than a full build"
            );
        }
        for build_mode in [
            "arduino-cli-full-fallback",
            "arduino-cli-incremental-fallback",
            "arduino-cli-incremental",
            "unknown",
        ] {
            assert!(
                !quick_fast_safe(&run(build_mode, false), "simple"),
                "{build_mode} must not qualify a candidate"
            );
        }
        assert!(
            !quick_fast_safe(&run("fast-relink", true), "complex"),
            "a fallback flag invalidates a nominal fast-relink build mode"
        );
        assert!(
            !quick_fast_safe(
                &serde_json::json!({
                    "candidateRoute": "ordinary-product-route",
                    "buildMode": "fast-relink",
                    "fallbackUsed": false,
                }),
                "complex"
            ),
            "ordinary product routing is not qualification-token evidence"
        );
    }

    #[test]
    fn portable_fast_execution_requires_native_recipe_cache_evidence() {
        let run = |build_mode: &str, fallback_used: bool| {
            serde_json::json!({
                "candidateRoute": "qualification-token-probe",
                "buildMode": build_mode,
                "fallbackUsed": fallback_used,
                "ccacheEnabled": true,
                "recipeCapability": {
                    "intent": PORTABLE_FAST_RECIPE_INTENT,
                },
            })
        };
        let portable_fast_safe = |run: &serde_json::Value, stage| {
            ck_run_execution_is_qualification_safe(
                run,
                stage,
                ForgePerformanceProfile::PortableFast,
            )
        };

        for build_mode in [
            "full-build",
            "arduino-cli-full-fallback",
            "arduino-cli-incremental",
            "arduino-cli-incremental-fallback",
            "arduino-cli-core-seeded",
        ] {
            assert!(
                portable_fast_safe(&run(build_mode, false), "complex"),
                "{build_mode} is a native Arduino CLI execution path"
            );
        }
        for build_mode in [
            "fast-relink",
            "native-relink-compile-only",
            "native-relink-graph-transition",
            "exact-match",
            "unknown",
        ] {
            assert!(
                !portable_fast_safe(&run(build_mode, false), "complex"),
                "{build_mode} must not qualify PortableFast"
            );
        }

        let mut missing_ccache = run("arduino-cli-incremental", false);
        missing_ccache
            .as_object_mut()
            .expect("run object")
            .remove("ccacheEnabled");
        assert!(!portable_fast_safe(&missing_ccache, "complex"));

        let mut wrong_intent = run("arduino-cli-incremental", false);
        wrong_intent["recipeCapability"]["intent"] = serde_json::json!("compile");
        assert!(!portable_fast_safe(&wrong_intent, "complex"));
        assert!(
            !portable_fast_safe(&run("arduino-cli-incremental", true), "complex"),
            "token-bound route fallback invalidates a nominal native build mode"
        );
        assert!(
            !portable_fast_safe(
                &serde_json::json!({
                    "candidateRoute": "ordinary-product-route",
                    "buildMode": "arduino-cli-incremental",
                    "fallbackUsed": false,
                    "ccacheEnabled": true,
                    "recipeCapability": { "intent": PORTABLE_FAST_RECIPE_INTENT },
                }),
                "complex"
            ),
            "ordinary product routing cannot be converted into PortableFast evidence"
        );
    }

    #[test]
    fn portable_fast_is_compile_only_and_proves_its_route_label() {
        let probe = ForgeQualificationProbe::parse("compile", "portable-fast")
            .expect("PortableFast compile qualification probe");
        assert_eq!(probe.operation, ForgePerformanceOperation::Compile);
        assert_eq!(probe.profile, ForgePerformanceProfile::PortableFast);
        assert_eq!(probe.profile_label(), "portable-fast");
        assert!(ForgeQualificationProbe::parse("upload-ready", "portable-fast").is_err());
        assert!(ForgeQualificationProbe::parse("compile", "shared-fast").is_err());

        let generic_candidate = serde_json::json!({});
        assert_eq!(
            fast_artifact_equivalence_policy_id(
                &generic_candidate,
                ForgePerformanceOperation::Compile,
                ForgePerformanceProfile::PortableFast,
            ),
            Some(GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID),
            "PortableFast uses exact artifact roles by default",
        );
        let esp_recipe_candidate = serde_json::json!({
            "lanes": { "ck": { "identity": {
                "corePackage": "esp32",
                "coreArchitecture": "esp32",
                "coreVersion": "3.3.6"
            }}},
            "portableFastEspApplicationBinRecipeProof": {
                "schemaVersion": 1,
                "kind": "esp32-platform-recipe-elf-sha256-offset-v1",
                "corePackage": "esp32",
                "coreArchitecture": "esp32",
                "coreVersion": "3.3.6",
                "recipeProperty": "recipe.objcopy.bin.pattern_args",
                "recipeSource": "platform.txt",
                "recipeSourceSha256": "a".repeat(64),
                "recipeValueSha256": "b".repeat(64),
                "elfSha256OffsetArgument": "--elf-sha256-offset 0xb0",
                "elfSha256Offset": 176
            }
        });
        assert_eq!(
            fast_artifact_equivalence_policy_id(
                &esp_recipe_candidate,
                ForgePerformanceOperation::Compile,
                ForgePerformanceProfile::PortableFast,
            ),
            Some(PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID),
            "the ESP exception requires a recipe proof bound to this exact Core",
        );
        let mut malformed_recipe_candidate = esp_recipe_candidate.clone();
        malformed_recipe_candidate["portableFastEspApplicationBinRecipeProof"]["elfSha256Offset"] =
            serde_json::json!(175);
        assert!(
            fast_artifact_equivalence_policy_id(
                &malformed_recipe_candidate,
                ForgePerformanceOperation::Compile,
                ForgePerformanceProfile::PortableFast,
            )
            .is_none()
        );
        assert_eq!(
            fast_artifact_equivalence_policy_id(
                &generic_candidate,
                ForgePerformanceOperation::Compile,
                ForgePerformanceProfile::QuickFast,
            ),
            Some(COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID),
        );
        assert_eq!(
            fast_artifact_equivalence_policy_id(
                &generic_candidate,
                ForgePerformanceOperation::UploadReady,
                ForgePerformanceProfile::PortableFast,
            ),
            None,
        );
        assert_eq!(
            validated_operation_profile(&serde_json::json!({
                "operation": "compile",
                "candidateProfile": "portable-fast",
            })),
            Some((
                ForgePerformanceOperation::Compile,
                ForgePerformanceProfile::PortableFast,
            )),
        );
        assert!(
            validated_operation_profile(&serde_json::json!({
                "operation": "upload-ready",
                "candidateProfile": "portable-fast",
            }))
            .is_none()
        );

        let route = serde_json::json!({
            "profile": "portable-fast",
            "qualificationOperation": "compile",
            "qualificationProfile": "portable-fast",
            "ckContractId": current_forge_contract_id(),
            "recipeCapability": {
                "schemaVersion": 2,
                "observationOnly": true,
                "capabilityGatePassed": true,
                "baselineSha256": "a".repeat(64),
                "intent": PORTABLE_FAST_RECIPE_INTENT,
                "requiredCapabilities": ["complete-native-recipe"],
                "missingCapabilities": [],
            },
        });
        assert!(ck_run_route_is_valid(
            &route,
            ForgePerformanceOperation::Compile,
            ForgePerformanceProfile::PortableFast,
        ));
        assert!(!ck_run_route_is_valid(
            &route,
            ForgePerformanceOperation::UploadReady,
            ForgePerformanceProfile::PortableFast,
        ));
    }

    #[test]
    fn rust_performance_gate_requires_five_trials_and_a_25_percent_gain() {
        let evidence = ForgePerformanceEvidence {
            operation: ForgePerformanceOperation::Compile,
            candidate_profile: ForgePerformanceProfile::QuickFast,
            host_identity_sha256: "a".repeat(64),
            sample_set_sha256: "b".repeat(64),
            samples_per_lane: 5,
            native_fresh_median_ms: 10_000,
            candidate_fresh_median_ms: 7_500,
            native_repeat_median_ms: 10_000,
            candidate_repeat_median_ms: 7_500,
            native_fresh_p95_ms: 10_000,
            candidate_fresh_p95_ms: 7_500,
            native_repeat_p95_ms: 10_000,
            candidate_repeat_p95_ms: 7_500,
            native_fresh_cv_basis_points: 0,
            candidate_fresh_cv_basis_points: 0,
            native_repeat_cv_basis_points: 0,
            candidate_repeat_cv_basis_points: 0,
            artifact_equivalent: true,
            resource_equivalent: true,
            evidence_sha256: "c".repeat(64),
            artifact_set_sha256: "d".repeat(64),
        };
        assert!(performance_ab_passes(&evidence));

        let mut portable_fast = evidence.clone();
        portable_fast.candidate_profile = ForgePerformanceProfile::PortableFast;
        assert!(performance_ab_passes(&portable_fast));
        let capabilities = performance_capabilities(
            &[portable_fast.clone()],
            portable_fast.host_identity_sha256.as_str(),
        );
        assert!(capabilities.compile_portable_fast);
        assert!(capabilities.allows(
            ForgePerformanceOperation::Compile,
            ForgePerformanceProfile::PortableFast,
        ));
        assert!(!capabilities.allows(
            ForgePerformanceOperation::UploadReady,
            ForgePerformanceProfile::PortableFast,
        ));
        assert!(!capabilities.allows(
            ForgePerformanceOperation::Compile,
            ForgePerformanceProfile::QuickFast,
        ));

        portable_fast.operation = ForgePerformanceOperation::UploadReady;
        assert!(!performance_ab_passes(&portable_fast));

        let mut too_few_trials = evidence.clone();
        too_few_trials.samples_per_lane = 4;
        assert!(!performance_ab_passes(&too_few_trials));

        let mut only_ten_percent_faster = evidence;
        only_ten_percent_faster.candidate_fresh_median_ms = 9_000;
        only_ten_percent_faster.candidate_repeat_median_ms = 9_000;
        only_ten_percent_faster.candidate_fresh_p95_ms = 9_000;
        only_ten_percent_faster.candidate_repeat_p95_ms = 9_000;
        assert!(!performance_ab_passes(&only_ten_percent_faster));
    }

    #[test]
    fn compile_only_application_parity_accepts_native_packaging_but_not_elf_drift() {
        let artifact = |name: &str, role: &str, bytes: u64, sha256: &str, primary: bool| {
            serde_json::json!({
                "name": name,
                "role": role,
                "bytes": bytes,
                "sha256": sha256,
                "primaryApplication": primary,
            })
        };
        let run = |artifacts: serde_json::Value| {
            let artifact_set_sha256 = sha256_bytes(canonical_json(&artifacts).as_bytes());
            serde_json::json!({
                "artifacts": artifacts,
                "artifactSetSha256": artifact_set_sha256,
            })
        };
        let ck = run(serde_json::json!([artifact(
            "ck.ino.elf",
            "application-elf",
            900,
            &"a".repeat(64),
            true
        ),]));
        let native = run(serde_json::json!([
            artifact(
                "native.ino.elf",
                "application-elf",
                900,
                &"a".repeat(64),
                true
            ),
            artifact(
                "native.ino.bin",
                "application-bin",
                700,
                &"b".repeat(64),
                true
            ),
            artifact(
                "native.ino.bootloader.bin",
                "bootloader-bin",
                80,
                &"c".repeat(64),
                false
            ),
        ]));
        assert!(compile_only_application_artifacts_equivalent(&ck, &native));
        assert!(
            !generic_run_artifacts_equivalent(&ck, &native),
            "PortableFast must reject native-only upload packaging roles rather than using QuickFast's primary-only exception"
        );

        let drifted = run(serde_json::json!([
            artifact(
                "native.ino.elf",
                "application-elf",
                900,
                &"d".repeat(64),
                true
            ),
            artifact(
                "native.ino.bin",
                "application-bin",
                700,
                &"b".repeat(64),
                true
            ),
        ]));
        assert!(!compile_only_application_artifacts_equivalent(
            &ck, &drifted
        ));
    }

    #[test]
    fn portable_fast_esp_payload_exception_is_limited_to_the_bound_image_ranges() {
        let witness = |bytes: u64, prefix: &str, body: &str, footer_hash: &str, checksum: u64| {
            serde_json::json!({
                "schemaVersion": 1,
                "kind": "esp-application-bin-elf-sha256-offset-v1",
                "recipe": {
                    "elfSha256OffsetArgument": "--elf-sha256-offset 0xb0",
                    "elfSha256Offset": 176,
                },
                "byteLength": bytes,
                "mutableRange": { "offset": 176, "length": 32 },
                "immutableSegments": [
                    { "offset": 0, "length": 176, "sha256": prefix },
                    { "offset": 208, "length": bytes - 241, "sha256": body },
                ],
                "footer": {
                    "offset": bytes - 33,
                    "length": 33,
                    "checksumOffset": bytes - 33,
                    "checksum": checksum,
                    "validationHash": footer_hash,
                    "checksumValid": true,
                    "validationHashValid": true,
                },
            })
        };
        let artifact = |name: &str,
                        role: &str,
                        bytes: u64,
                        sha256: &str,
                        primary: bool,
                        witness: Option<serde_json::Value>| {
            let mut artifact = serde_json::json!({
                "name": name,
                "role": role,
                "bytes": bytes,
                "sha256": sha256,
                "primaryApplication": primary,
            });
            if let Some(witness) = witness {
                artifact["payloadEquivalenceWitness"] = witness;
            }
            artifact
        };
        let run = |artifacts: serde_json::Value| {
            let base = artifacts
                .as_array()
                .expect("artifact array")
                .iter()
                .map(|artifact| {
                    serde_json::json!({
                        "name": artifact["name"].clone(),
                        "bytes": artifact["bytes"].clone(),
                        "sha256": artifact["sha256"].clone(),
                        "primaryApplication": artifact["primaryApplication"].clone(),
                        "role": artifact["role"].clone(),
                    })
                })
                .collect::<Vec<_>>();
            serde_json::json!({
                "artifacts": artifacts,
                "artifactSetSha256": sha256_bytes(canonical_json(&serde_json::Value::Array(base)).as_bytes()),
            })
        };
        let ck = run(serde_json::json!([
            artifact(
                "ck.ino.elf",
                "application-elf",
                900,
                &"1".repeat(64),
                true,
                None,
            ),
            artifact(
                "ck.merged.bin",
                "merged-firmware-bin",
                1_024,
                &"7".repeat(64),
                false,
                None,
            ),
            artifact(
                "ck.ino.bin",
                "application-bin",
                512,
                &"2".repeat(64),
                true,
                Some(witness(
                    512,
                    &"3".repeat(64),
                    &"4".repeat(64),
                    &"5".repeat(64),
                    31
                )),
            ),
        ]));
        let native = run(serde_json::json!([
            artifact(
                "native.ino.elf",
                "application-elf",
                900,
                &"8".repeat(64),
                true,
                None,
            ),
            artifact(
                "native.merged.bin",
                "merged-firmware-bin",
                1_024,
                &"9".repeat(64),
                false,
                None,
            ),
            artifact(
                "native.ino.bin",
                "application-bin",
                512,
                &"6".repeat(64),
                true,
                Some(witness(
                    512,
                    &"3".repeat(64),
                    &"4".repeat(64),
                    &"7".repeat(64),
                    47
                )),
            ),
        ]));
        assert!(!generic_run_artifacts_equivalent(&ck, &native));
        assert!(
            portable_fast_run_artifacts_equivalent(&ck, &native),
            "the recipe-bound policy allows path-derived ELF/merged outputs and the image digest/footer only"
        );

        let mut immutable_drift = native.clone();
        immutable_drift["artifacts"][2]["payloadEquivalenceWitness"]["immutableSegments"][1]["sha256"] =
            serde_json::json!("8".repeat(64));
        assert!(
            !portable_fast_run_artifacts_equivalent(&ck, &immutable_drift),
            "a byte-range witness cannot hide a mismatch outside the fixed mutable windows"
        );

        let mut flash_drift = native.clone();
        flash_drift["artifacts"]
            .as_array_mut()
            .expect("artifact array")
            .push(artifact(
                "ck.flash_args",
                "flash-arguments",
                64,
                &"a".repeat(64),
                false,
                None,
            ));
        let mut flash_native_artifacts = native["artifacts"].clone();
        flash_native_artifacts
            .as_array_mut()
            .expect("artifact array")
            .push(artifact(
                "native.flash_args",
                "flash-arguments",
                64,
                &"b".repeat(64),
                false,
                None,
            ));
        let flash_native = run(flash_native_artifacts);
        let flash_drift = run(flash_drift["artifacts"].clone());
        assert!(
            !portable_fast_run_artifacts_equivalent(&flash_drift, &flash_native),
            "flash-arguments remain exact under the ESP image exception"
        );

        let mut missing_derived_artifacts = native["artifacts"].clone();
        missing_derived_artifacts
            .as_array_mut()
            .expect("artifact array")
            .remove(1);
        let missing_derived = run(missing_derived_artifacts);
        assert!(
            !portable_fast_run_artifacts_equivalent(&ck, &missing_derived),
            "derived ELF/merged roles may vary in content, but must remain present exactly once"
        );

        let mut malformed_witness = native.clone();
        malformed_witness["artifacts"][2]["payloadEquivalenceWitness"]["mutableRange"]["offset"] =
            serde_json::json!(175);
        assert!(!portable_fast_run_artifacts_equivalent(
            &ck,
            &malformed_witness
        ));
    }

    #[test]
    fn artifact_set_binding_ignores_optional_payload_witness_but_not_artifact_identity() {
        let base_artifacts = serde_json::json!([{
            "name": "firmware.ino.bin",
            "role": "application-bin",
            "bytes": 512,
            "sha256": "a".repeat(64),
            "primaryApplication": true,
        }]);
        let base_hash = sha256_bytes(canonical_json(&base_artifacts).as_bytes());
        assert_eq!(
            base_hash, "105ba90cbfe774b22d0a4ddb4c917732fd447ceed1eeb1a079fe10b1b38b29ba",
            "fixed vector shared with the Node qualification evaluator"
        );
        let mut run = serde_json::json!({
            "artifacts": base_artifacts,
            "artifactSetSha256": base_hash,
        });
        run["artifacts"][0]["payloadEquivalenceWitness"] = serde_json::json!({
            "schemaVersion": 1,
            "untrustedForArtifactSet": true,
        });
        assert!(run_artifact_set_is_bound(&run));

        run["artifacts"][0]["sha256"] = serde_json::json!("b".repeat(64));
        assert!(
            !run_artifact_set_is_bound(&run),
            "the optional witness cannot hide a changed artifact digest"
        );
    }

    fn native_test_artifacts() -> serde_json::Value {
        serde_json::json!([
            {
                "name": "fixture.hex",
                "role": "avr-application-hex",
                "bytes": 3,
                "sha256": "a".repeat(64),
                "primaryApplication": true
            },
            {
                "name": "fixture.eep",
                "role": "avr-eeprom",
                "bytes": 1,
                "sha256": "b".repeat(64),
                "primaryApplication": false
            }
        ])
    }

    #[test]
    fn avr_eeprom_artifact_is_optional_only_when_absent_in_both_lanes() {
        let hex = serde_json::json!({
            "name": "fixture.hex",
            "role": "avr-application-hex",
            "bytes": 3,
            "sha256": "a".repeat(64),
        });
        let eeprom = serde_json::json!({
            "name": "fixture.eep",
            "role": "avr-eeprom",
            "bytes": 1,
            "sha256": "b".repeat(64),
        });
        let ck_without_eeprom = vec![hex.clone()];
        let native_without_eeprom = vec![hex.clone()];
        assert!(optional_artifact_role_matches(
            &ck_without_eeprom,
            &native_without_eeprom,
            "avr-eeprom",
        ));

        let native_with_eeprom = vec![hex.clone(), eeprom.clone()];
        assert!(!optional_artifact_role_matches(
            &ck_without_eeprom,
            &native_with_eeprom,
            "avr-eeprom",
        ));
        assert!(!optional_artifact_role_matches(
            &native_with_eeprom,
            &ck_without_eeprom,
            "avr-eeprom",
        ));

        let drifted_eeprom = serde_json::json!({
            "name": "fixture.eep",
            "role": "avr-eeprom",
            "bytes": 1,
            "sha256": "c".repeat(64),
        });
        assert!(!optional_artifact_role_matches(
            &[hex.clone(), eeprom.clone()],
            &[hex.clone(), drifted_eeprom],
            "avr-eeprom",
        ));
        let byte_drifted_eeprom = serde_json::json!({
            "name": "fixture.eep",
            "role": "avr-eeprom",
            "bytes": 2,
            "sha256": "b".repeat(64),
        });
        assert!(!optional_artifact_role_matches(
            &[hex.clone(), eeprom],
            &[hex, byte_drifted_eeprom],
            "avr-eeprom",
        ));
    }

    #[test]
    fn esp32_witness_role_requires_matching_immutable_segments_on_digest_mismatch() {
        let witness = |bytes: u64, prefix: &str, body: &str, footer_hash: &str, checksum: u64| {
            serde_json::json!({
                "schemaVersion": 1,
                "kind": "esp-application-bin-elf-sha256-offset-v1",
                "recipe": {
                    "elfSha256OffsetArgument": "--elf-sha256-offset 0xb0",
                    "elfSha256Offset": 176,
                },
                "byteLength": bytes,
                "mutableRange": { "offset": 176, "length": 32 },
                "immutableSegments": [
                    { "offset": 0, "length": 176, "sha256": prefix },
                    { "offset": 208, "length": bytes - 241, "sha256": body },
                ],
                "footer": {
                    "offset": bytes - 33,
                    "length": 33,
                    "checksumOffset": bytes - 33,
                    "checksum": checksum,
                    "validationHash": footer_hash,
                    "checksumValid": true,
                    "validationHashValid": true,
                },
            })
        };
        let artifact = |name: &str,
                        role: &str,
                        bytes: u64,
                        sha256: &str,
                        primary: bool,
                        witness: Option<serde_json::Value>| {
            let mut artifact = serde_json::json!({
                "name": name,
                "role": role,
                "bytes": bytes,
                "sha256": sha256,
                "primaryApplication": primary,
            });
            if let Some(witness) = witness {
                artifact["payloadEquivalenceWitness"] = witness;
            }
            artifact
        };
        let ck = vec![artifact(
            "ck.ino.bin",
            "application-bin",
            512,
            &"2".repeat(64),
            true,
            Some(witness(
                512,
                &"3".repeat(64),
                &"4".repeat(64),
                &"5".repeat(64),
                31,
            )),
        )];
        let native = vec![artifact(
            "native.ino.bin",
            "application-bin",
            512,
            &"6".repeat(64),
            true,
            Some(witness(
                512,
                &"3".repeat(64),
                &"4".repeat(64),
                &"7".repeat(64),
                47,
            )),
        )];
        assert!(
            witness_artifact_role_matches(&ck, &native, "application-bin"),
            "same-length digest mismatch with layout-equal witnesses and equal immutable segments passes"
        );
        assert!(
            !artifact_role_matches(&ck, &native, "application-bin"),
            "the exact required-role contract still rejects the digest mismatch"
        );

        let identical_native = vec![artifact(
            "native.ino.bin",
            "application-bin",
            512,
            &"2".repeat(64),
            true,
            None,
        )];
        assert!(
            witness_artifact_role_matches(&ck, &identical_native, "application-bin"),
            "byte-identical images need no payload witness"
        );

        let witnessless_native = vec![artifact(
            "native.ino.bin",
            "application-bin",
            512,
            &"6".repeat(64),
            true,
            None,
        )];
        assert!(
            !witness_artifact_role_matches(&ck, &witnessless_native, "application-bin"),
            "a digest mismatch without a witness on one lane fails closed"
        );

        let mut segment_drift = native.clone();
        segment_drift[0]["payloadEquivalenceWitness"]["immutableSegments"][1]["sha256"] =
            serde_json::json!("8".repeat(64));
        assert!(
            !witness_artifact_role_matches(&ck, &segment_drift, "application-bin"),
            "immutable-segment drift is a real content difference"
        );

        let mut length_drift = native.clone();
        length_drift[0]["bytes"] = serde_json::json!(513_u64);
        length_drift[0]["payloadEquivalenceWitness"] =
            witness(513, &"3".repeat(64), &"4".repeat(64), &"7".repeat(64), 47);
        assert!(
            !witness_artifact_role_matches(&ck, &length_drift, "application-bin"),
            "witness roles require byte-length equality"
        );

        let mut not_primary = native.clone();
        not_primary[0]["primaryApplication"] = serde_json::json!(false);
        assert!(
            !witness_artifact_role_matches(&ck, &not_primary, "application-bin"),
            "witness roles must be the primary application in both lanes"
        );

        let duplicated_native = vec![native[0].clone(), native[0].clone()];
        assert!(
            !witness_artifact_role_matches(&ck, &duplicated_native, "application-bin"),
            "witness roles must be unique per lane"
        );
    }

    fn native_test_run(fqbn: &str, source_sha256: &str, wall_ms: f64) -> serde_json::Value {
        let artifacts = native_test_artifacts();
        let artifact_set_sha256 =
            native_artifact_set_sha256(artifacts.as_array().expect("test artifact array"))
                .expect("test artifact set SHA");
        let mut run = serde_json::json!({
            "success": true,
            "compileOnly": true,
            "uploadPerformed": false,
            "exactUsed": false,
            "codeSha256": source_sha256,
            "artifactsVerified": true,
            "wallMs": wall_ms,
            "artifacts": artifacts,
            "artifactSetSha256": artifact_set_sha256,
            "resources": {
                "evidenceComplete": true,
                "flashUsedBytes": 321,
                "ramUsedBytes": 45
            },
            "fqbn": fqbn,
            "cliVersion": TEST_CLI_VERSION,
            "toolchainKey": TEST_TOOLCHAIN_KEY,
            "route": {
                "coreVersion": TEST_CORE_VERSION,
                "contractId": current_forge_contract_id()
            },
            "buildMode": NATIVE_RELINK_PROFILE_ID
        });
        let evidence_sha256 =
            sha256_bytes(canonical_json(&native_run_integrity_projection(&run)).as_bytes());
        run.as_object_mut().expect("test run object").insert(
            "evidenceSha256".into(),
            serde_json::Value::String(evidence_sha256),
        );
        run
    }

    fn write_valid_native_relink_qualification(sysroot: &std::path::Path, fqbn: &str) -> (String, String) {
        let cli_executable_sha256 = write_test_cli(sysroot);
        let host_identity_sha256 = host_environment_fingerprint(sysroot);
        let production_executable_sha256 =
            current_production_executable_sha256().expect("test executable SHA");
        let sequence_sha256 = portable_edit_sequence_sha256();
        let adapter = native_relink_adapter_for(fqbn, Some("avr")).expect("AVR adapter");
        let qualification_key = native_relink_qualification_key_for_adapter(
            fqbn,
            TEST_CORE_VERSION,
            TEST_TOOLCHAIN_KEY,
            TEST_CLI_VERSION,
            &cli_executable_sha256,
            &host_identity_sha256,
            &production_executable_sha256,
            &sequence_sha256,
            current_forge_contract_id(),
            adapter,
        );
        let capture_order = [
            "ck-native",
            "native-ck",
            "ck-native",
            "native-ck",
            "ck-native",
        ];
        let trials = capture_order
            .iter()
            .enumerate()
            .map(|(index, order)| {
                let mut ck = serde_json::Map::new();
                ck.insert(
                    "cacheClear".into(),
                    serde_json::json!({
                        "reset_scope": "first-project-full-fqbn",
                        "force_rebuild_pending": false,
                        "ccache_store_preserved": true
                    }),
                );
                let mut native = serde_json::Map::new();
                for (stage, source_sha256) in PORTABLE_EDIT_STAGES {
                    ck.insert(stage.into(), native_test_run(fqbn, source_sha256, 1_000.0));
                    native.insert(stage.into(), native_test_run(fqbn, source_sha256, 2_500.0));
                }
                serde_json::json!({
                    "id": format!("trial-{:03}", index + 1),
                    "order": order,
                    "ck": ck,
                    "native": native
                })
            })
            .collect::<Vec<_>>();
        let evidence = serde_json::json!({
            "schemaId": NATIVE_RELINK_RUN_SCHEMA_ID,
            "schemaVersion": 2,
            "measurementStatus": "passed",
            "failures": [],
            "checks": [{ "passed": true }],
            "runner": { "unchanged": true },
            "productionExecutable": {
                "unchanged": true,
                "before": { "executableSha256": production_executable_sha256 },
                "after": { "executableSha256": production_executable_sha256 }
            },
            "controls": {
                "compileOnly": true,
                "sameMachine": true,
                "sameBundledCli": true,
                "sameCliConfig": true,
                "sameCoreAndCompleteFqbn": true,
                "sameSourceBytes": true,
                "sameParallelJobs": true,
                "globalCachesSharedEqually": true,
                "externalShortBuildPaths": true,
                "sequentialNoConcurrentCompiles": true,
                "ckQualificationMode": true,
                "sameBuildPathWithinLane": true,
                "qualificationTokenBound": true,
                "uploadPerformed": false,
                "physicalFlashWritten": false,
                "serialPortAccessed": false,
                "exactAllowed": false,
                "exactCountedAsFresh": false,
                "measurementSequence": "portable-edit",
                "requiredCkMode": NATIVE_RELINK_PROFILE_ID,
                "nativeRelinkAdapterId": adapter.id,
                "nativeRelinkEngineContractId": adapter.engine_contract_id,
                "artifactEquivalencePolicyId": adapter.artifact_policy_id
            },
            "identity": {
                "fqbn": fqbn,
                "coreArchitecture": "avr",
                "coreVersion": TEST_CORE_VERSION,
                "cliVersion": TEST_CLI_VERSION,
                "cliExecutableSha256": cli_executable_sha256,
                "hostIdentitySha256": host_identity_sha256,
                "productionExecutableSha256": production_executable_sha256,
                "sequenceSha256": sequence_sha256,
                "runnerSha256": "c".repeat(64)
            },
            "stages": PORTABLE_EDIT_STAGES
                .iter()
                .map(|(id, source_sha256)| serde_json::json!({
                    "id": id,
                    "sourceSha256": source_sha256
                }))
                .collect::<Vec<_>>(),
            "captureOrder": capture_order,
            "trials": trials
        });
        let evidence_bytes = serde_json::to_vec(&evidence).expect("serialize evidence");
        let evidence_sha256 = sha256_bytes(&evidence_bytes);
        let report = serde_json::json!({
            "schemaId": NATIVE_RELINK_REPORT_SCHEMA_ID,
            "schemaVersion": 1,
            "evidenceSha256": evidence_sha256,
            "qualificationKey": qualification_key,
            "operation": "compile",
            "candidateProfile": NATIVE_RELINK_PROFILE_ID,
            "status": "qualified-native-relink",
            "recommendedRoute": NATIVE_RELINK_PROFILE_ID,
            "qualified": true,
            "coldSimpleRequiredToWin": false,
            "trialCountPerLane": 5,
            "policy": { "id": NATIVE_RELINK_POLICY_ID },
            "target": {
                "fqbn": fqbn,
                "coreVersion": TEST_CORE_VERSION,
                "toolchainKey": TEST_TOOLCHAIN_KEY,
                "cliVersion": TEST_CLI_VERSION,
                "cliExecutableSha256": cli_executable_sha256,
                "hostIdentitySha256": host_identity_sha256,
                "productionExecutableSha256": production_executable_sha256,
                "sequenceSha256": sequence_sha256
            },
            "ckContractId": current_forge_contract_id(),
            "nativeRelinkAdapterId": adapter.id,
            "nativeRelinkContractId": adapter.engine_contract_id,
            "artifactEquivalencePolicyId": adapter.artifact_policy_id,
            "stages": [
                { "id": "complex", "qualified": true },
                { "id": "medium", "qualified": true },
                { "id": "simple-return", "qualified": true }
            ]
        });
        let report_bytes = serde_json::to_vec(&report).expect("serialize report");
        let certificate = serde_json::json!({
            "schemaId": LOCAL_QUALIFICATION_SCHEMA_ID,
            "schemaVersion": 4,
            "candidateProfile": NATIVE_RELINK_PROFILE_ID,
            "evidenceSha256": evidence_sha256,
            "reportSha256": sha256_bytes(&report_bytes)
        });
        let directory = sysroot
            .join("state")
            .join("qualifications")
            .join(&qualification_key);
        std::fs::create_dir_all(&directory).expect("qualification directory");
        std::fs::write(directory.join("evidence.json"), evidence_bytes).expect("write evidence");
        std::fs::write(directory.join("report.json"), report_bytes).expect("write report");
        std::fs::write(
            directory.join("certificate.json"),
            serde_json::to_vec(&certificate).expect("serialize certificate"),
        )
        .expect("write certificate");
        (qualification_key, evidence_sha256)
    }

    #[test]
    fn adapter_registry_is_explicit_and_samd_is_exactly_mkrzero_only() {
        let avr = native_relink_adapter_for("arduino:avr:uno", Some("avr"))
            .expect("AVR adapter must be registered");
        assert_eq!(avr.id, "arduino-avr-native-relink-v1");
        assert_eq!(
            avr.engine_contract_id,
            "ck-native-relink-avr-release-compile-only-v2"
        );
        assert_eq!(
            avr.artifact_policy_id,
            "arduino-avr-hex-required-eeprom-optional-exact-v2"
        );
        assert_eq!(avr.required_artifact_roles, &["avr-application-hex"]);
        assert!(avr.witness_artifact_roles.is_empty());
        assert_eq!(avr.optional_artifact_roles, &["avr-eeprom"]);
        assert!(native_relink_adapter_for("arduino:avr:uno", Some("samd")).is_none());
        let samd = native_relink_adapter_for("arduino:samd:mkrzero", Some("samd"))
            .expect("MKR Zero adapter must be registered");
        assert_eq!(samd.id, "arduino-samd-mkrzero-native-relink-v1");
        assert_eq!(
            samd.engine_contract_id,
            "ck-native-relink-samd-release-compile-only-phase1-v1"
        );
        assert_eq!(
            samd.artifact_policy_id,
            "arduino-samd-app-bin-hex-exact-ck-edit-no-bootloader-v2"
        );
        assert!(samd.witness_artifact_roles.is_empty());
        assert!(
            native_relink_adapter_for("arduino:samd:mkrzero:usbstack=arduino", Some("samd"))
                .is_some()
        );
        for fqbn in [
            "arduino:samd:mkrzero_clone",
            "arduino:samd:arduino_zero_native",
            "arduino:samd:mkrwifi1010",
        ] {
            assert!(native_relink_adapter_for(fqbn, Some("samd")).is_none());
        }
        let esp32 = native_relink_adapter_for("esp32:esp32:esp32c6", Some("esp32"))
            .expect("ESP32-C6 adapter must be registered");
        assert_eq!(esp32.id, "esp32-esp32c6-native-relink-v1");
        assert_eq!(
            esp32.engine_contract_id,
            "ck-native-relink-esp32-release-compile-only-phase1-v1"
        );
        assert_eq!(
            esp32.artifact_policy_id,
            "esp32-app-bin-witness-bootloader-partitions-exact-v1"
        );
        assert_eq!(
            esp32.required_artifact_roles,
            &["bootloader-bin", "partitions-bin"]
        );
        assert_eq!(esp32.witness_artifact_roles, &["application-bin"]);
        assert!(esp32.optional_artifact_roles.is_empty());
        assert!(esp32.forbidden_all_stage_artifact_roles.is_empty());
        assert!(esp32.forbidden_ck_edit_artifact_roles.is_empty());
        assert!(
            native_relink_adapter_for(
                "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB",
                Some("esp32"),
            )
            .is_some()
        );
        assert!(native_relink_adapter_for("esp32:esp32:esp32c6", Some("avr")).is_none());
        // Every generic ESP32 base is its own exact adapter row sharing the
        // phase-1 contract; clones and named variants stay unregistered.
        for (board, expected_id) in [
            ("esp32:esp32:esp32", "esp32-esp32-native-relink-v1"),
            ("esp32:esp32:esp32s2", "esp32-esp32s2-native-relink-v1"),
            ("esp32:esp32:esp32s3", "esp32-esp32s3-native-relink-v1"),
            ("esp32:esp32:esp32c3", "esp32-esp32c3-native-relink-v1"),
            ("esp32:esp32:esp32c5", "esp32-esp32c5-native-relink-v1"),
            ("esp32:esp32:esp32h2", "esp32-esp32h2-native-relink-v1"),
            ("esp32:esp32:esp32p4", "esp32-esp32p4-native-relink-v1"),
        ] {
            let adapter = native_relink_adapter_for(board, Some("esp32"))
                .unwrap_or_else(|| panic!("{board} adapter must be registered"));
            assert_eq!(adapter.id, expected_id);
            assert_eq!(
                adapter.engine_contract_id,
                "ck-native-relink-esp32-release-compile-only-phase1-v1"
            );
            assert_eq!(
                adapter.artifact_policy_id,
                "esp32-app-bin-witness-bootloader-partitions-exact-v1"
            );
            assert_eq!(adapter.witness_artifact_roles, &["application-bin"]);
        }
        for fqbn in [
            "esp32:esp32:esp32c6_clone",
            "esp32:esp32:esp32wrover",
            "esp32:esp32:esp32da",
        ] {
            assert!(native_relink_adapter_for(fqbn, Some("esp32")).is_none());
        }
        assert!(native_relink_adapter_for("thirdparty:custom:board", None).is_none());
    }

    #[test]
    fn adapter_contract_matching_uses_registry_identity_without_opening_new_lanes() {
        let controls = serde_json::json!({
            "nativeRelinkAdapterId": "arduino-avr-native-relink-v1",
            "nativeRelinkEngineContractId": "ck-native-relink-avr-release-compile-only-v2",
            "artifactEquivalencePolicyId": "arduino-avr-hex-required-eeprom-optional-exact-v2",
        });
        assert!(native_relink_adapter_contract_matches(
            "arduino:avr:uno",
            Some("avr"),
            &controls,
        ));
        assert!(!native_relink_adapter_contract_matches(
            "arduino:samd:mkrzero",
            Some("samd"),
            &controls,
        ));
        let samd_controls = serde_json::json!({
            "nativeRelinkAdapterId": "arduino-samd-mkrzero-native-relink-v1",
            "nativeRelinkEngineContractId": "ck-native-relink-samd-release-compile-only-phase1-v1",
            "artifactEquivalencePolicyId": "arduino-samd-app-bin-hex-exact-ck-edit-no-bootloader-v2",
        });
        assert!(native_relink_adapter_contract_matches(
            "arduino:samd:mkrzero:usbstack=arduino",
            Some("samd"),
            &samd_controls,
        ));
        assert!(!native_relink_adapter_contract_matches(
            "arduino:samd:mkrzero_clone",
            Some("samd"),
            &samd_controls,
        ));
        assert!(!native_relink_adapter_contract_matches(
            "arduino:avr:uno",
            Some("samd"),
            &controls,
        ));
        let mut legacy_policy_controls = controls.clone();
        legacy_policy_controls["artifactEquivalencePolicyId"] =
            serde_json::json!("arduino-avr-hex-eeprom-exact-v1");
        assert!(
            !native_relink_adapter_contract_matches(
                "arduino:avr:uno",
                Some("avr"),
                &legacy_policy_controls,
            ),
            "an old artifact policy must never authorize the AVR v2 engine"
        );
        let legacy_avr_controls = serde_json::json!({
            "nativeRelinkAdapterId": "arduino-avr-native-relink-v1",
            "nativeRelinkEngineContractId": "ck-native-relink-avr-release-compile-only-v1",
            "artifactEquivalencePolicyId": "arduino-avr-hex-eeprom-exact-v1",
        });
        assert!(
            !native_relink_adapter_contract_matches(
                "arduino:avr:uno",
                Some("avr"),
                &legacy_avr_controls,
            ),
            "a Phase-1 certificate must never authorize the AVR v2 engine"
        );
    }

    #[test]
    fn rust_binding_matches_the_independent_javascript_evaluator_fixture() {
        let sequence = portable_edit_sequence_sha256();
        assert_eq!(
            sequence,
            "b453c06daaa63bd6df776e8c5b24f60ebd33a11aff50a37f2e5bd325076d65f8"
        );
        assert_eq!(
            CK_FORGE_NATIVE_RELINK_COMPILE_ONLY_CONTRACT_ID,
            "ck-native-relink-avr-release-compile-only-v2"
        );
        assert_eq!(NATIVE_RELINK_BINDING_SCHEMA_VERSION, 3);
        let production_executable_sha256 = "5".repeat(64);
        let key = native_relink_qualification_key(
            "arduino:avr:uno",
            "1.8.6",
            "arduino|avr|1.8.6|74aab7d9d0f1f1686add0ec776206f8054f0c1e3531a2113b56ca54c031fd931",
            "arduino-cli  Version: 1.4.1 Commit: e39419312 Date: 2026-01-19T16:12:56Z",
            "8f73503f7ac280dc1245b085c4e856c9549eb1e88c2904c777bf229692ee4c39",
            "3c8d9136fbce589ba098f93c0c773c2d58ce7ea335fb68cae249af7c9f634768",
            &production_executable_sha256,
            &sequence,
            current_forge_contract_id(),
        );
        assert_eq!(
            key,
            "af085d85b31194c5a4704d1f5af9ae291e5ae31866b7228436078fb991605398"
        );
        let rebuilt_key = native_relink_qualification_key(
            "arduino:avr:uno",
            "1.8.6",
            "arduino|avr|1.8.6|74aab7d9d0f1f1686add0ec776206f8054f0c1e3531a2113b56ca54c031fd931",
            "arduino-cli  Version: 1.4.1 Commit: e39419312 Date: 2026-01-19T16:12:56Z",
            "8f73503f7ac280dc1245b085c4e856c9549eb1e88c2904c777bf229692ee4c39",
            "3c8d9136fbce589ba098f93c0c773c2d58ce7ea335fb68cae249af7c9f634768",
            &"6".repeat(64),
            &sequence,
            current_forge_contract_id(),
        );
        assert_ne!(
            key, rebuilt_key,
            "rebuilt CK must receive a new qualification key"
        );
        let esp32_key = native_relink_qualification_key_for_adapter(
            "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB",
            "3.3.6",
            "esp32|esp32|3.3.6|74aab7d9d0f1f1686add0ec776206f8054f0c1e3531a2113b56ca54c031fd931",
            "arduino-cli  Version: 1.4.1 Commit: e39419312 Date: 2026-01-19T16:12:56Z",
            "8f73503f7ac280dc1245b085c4e856c9549eb1e88c2904c777bf229692ee4c39",
            "3c8d9136fbce589ba098f93c0c773c2d58ce7ea335fb68cae249af7c9f634768",
            &production_executable_sha256,
            &sequence,
            current_forge_contract_id(),
            &ESP32C6_NATIVE_RELINK_ADAPTER,
        );
        assert_eq!(
            esp32_key, "78b391ddf2c8372bf989485ce1b7790daafa88ae17de24c598fc205f03814c77",
            "fixed vector shared with the Node qualification evaluator"
        );
        let avr_key_for_esp32_inputs = native_relink_qualification_key_for_adapter(
            "esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB",
            "3.3.6",
            "esp32|esp32|3.3.6|74aab7d9d0f1f1686add0ec776206f8054f0c1e3531a2113b56ca54c031fd931",
            "arduino-cli  Version: 1.4.1 Commit: e39419312 Date: 2026-01-19T16:12:56Z",
            "8f73503f7ac280dc1245b085c4e856c9549eb1e88c2904c777bf229692ee4c39",
            "3c8d9136fbce589ba098f93c0c773c2d58ce7ea335fb68cae249af7c9f634768",
            &production_executable_sha256,
            &sequence,
            current_forge_contract_id(),
            &AVR_NATIVE_RELINK_ADAPTER,
        );
        assert_ne!(
            esp32_key, avr_key_for_esp32_inputs,
            "the ESP32 engine contract cryptographically separates its certificates"
        );
    }

    #[test]
    fn runtime_production_executable_hash_reads_the_current_executable_bytes() {
        let executable = std::env::current_exe().expect("current test executable");
        let expected = sha256_bytes(&std::fs::read(executable).expect("read current executable"));
        assert_eq!(
            current_production_executable_sha256().as_deref(),
            Some(expected.as_str())
        );
    }

    #[test]
    fn portable_certificate_artifacts_are_bound_to_the_representative_candidate_bytes() {
        let temp = tempfile::tempdir().expect("artifact binding tempdir");
        let directory = temp.path().join("qualification");
        std::fs::create_dir_all(directory.join("artifacts")).expect("artifact directory");
        let bytes = b"qualified firmware bytes";
        let digest = sha256_bytes(bytes);
        std::fs::write(directory.join("artifacts/firmware.bin"), bytes).expect("artifact bytes");
        let manifest = serde_json::to_vec(&serde_json::json!({
            "schemaId": "ck.forge.qualification-artifact-set",
            "schemaVersion": 1,
            "artifacts": [{
                "path": "artifacts/firmware.bin",
                "size": bytes.len(),
                "sha256": digest
            }]
        }))
        .expect("artifact manifest");
        let (_, installed) =
            validate_artifact_set(&directory, &manifest).expect("valid artifact set");
        let representative = serde_json::json!({
            "artifacts": [{ "bytes": bytes.len(), "sha256": digest }]
        });
        assert_eq!(
            candidate_artifact_content_multiset(&representative),
            Some(installed.clone())
        );
        let unrelated = serde_json::json!({
            "artifacts": [{ "bytes": bytes.len(), "sha256": "a".repeat(64) }]
        });
        assert_ne!(
            candidate_artifact_content_multiset(&unrelated),
            Some(installed)
        );
    }

    #[test]
    fn portable_qualification_key_binds_cli_config_and_native_compiler_properties() {
        let identity = serde_json::json!({
            "fqbn": TEST_FQBN,
            "corePackage": "arduino",
            "coreArchitecture": "avr",
            "coreVersion": TEST_CORE_VERSION,
            "toolchainKey": TEST_TOOLCHAIN_KEY,
            "toolchainContentSha256": TEST_TOOLCHAIN_KEY.rsplit_once('|').unwrap().1,
            "sketchSha256": "1".repeat(64),
            "cliExecutableSha256": "2".repeat(64),
            "cliConfigSha256": "3".repeat(64),
            "cliVersion": TEST_CLI_VERSION,
            "hostIdentitySha256": "4".repeat(64),
            "productionExecutableSha256": "5".repeat(64)
        });
        let mut candidate = serde_json::json!({
            "lanes": { "ck": { "identity": identity } },
            "ckContractId": "fixture-contract",
            "compilePropertyDelta": "fixture delta",
            "nativeBaselineCompilerPropertiesSha256": "6".repeat(64),
            "artifactEquivalencePolicyId": "compile-only-shared-primary-application-exact-v1",
            "operation": "compile",
            "candidateProfile": "quick-fast",
            "measurementSequence": "portable-edit",
            "sequenceSha256": "7".repeat(64)
        });
        let original = compute_qualification_key(&candidate).expect("qualification key");
        let legacy_policy_key = compute_qualification_key_with_policy(
            &candidate,
            "ck-forge-portable-edit-no-regression-v2",
        )
        .expect("legacy policy key");
        assert_eq!(
            compute_qualification_key_with_policy(&candidate, PERFORMANCE_POLICY_ID),
            Some(original.clone())
        );
        assert_ne!(
            original, legacy_policy_key,
            "the stricter v3 policy must have a distinct qualification directory"
        );
        candidate["lanes"]["ck"]["identity"]["cliConfigSha256"] =
            serde_json::Value::String("8".repeat(64));
        let config_changed = compute_qualification_key(&candidate).expect("config key");
        assert_ne!(original, config_changed);
        candidate["nativeBaselineCompilerPropertiesSha256"] =
            serde_json::Value::String("9".repeat(64));
        assert_ne!(
            config_changed,
            compute_qualification_key(&candidate).expect("compiler property key")
        );
    }

    #[test]
    fn qualification_prefilter_skips_unrelated_schemas_and_exact_targets_only() {
        let temp = tempfile::tempdir().expect("qualification prefilter tempdir");
        let directory = temp
            .path()
            .join("state")
            .join("qualifications")
            .join("candidate");
        std::fs::create_dir_all(&directory).expect("candidate directory");
        let cli_path = if cfg!(windows) {
            temp.path().join("bin/arduino-cli.exe")
        } else {
            temp.path().join("bin/arduino-cli")
        };
        std::fs::create_dir_all(cli_path.parent().expect("CLI parent")).expect("CLI directory");
        std::fs::write(&cli_path, b"bounded CLI identity fixture").expect("CLI fixture");
        let toolchain =
            "arduino|avr|1.8.6|74aab7d9d0f1f1686add0ec776206f8054f0c1e3531a2113b56ca54c031fd931";
        let cli = "arduino-cli  Version: 1.4.1 Commit: e39419312 Date: 2026-01-19T16:12:56Z";
        std::fs::write(
            directory.join("certificate.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaId": "ck.forge.local-performance-certificate",
                "schemaVersion": 4,
                "candidateProfile": "native-relink-compile-only",
                "evidenceSha256": "a".repeat(64),
                "reportSha256": "b".repeat(64),
            }))
            .expect("native certificate json"),
        )
        .expect("native certificate");
        let report_path = directory.join("report.json");
        let native_report = serde_json::json!({
            "schemaId": "ck.forge.native-relink-local-qualification-report",
            "operation": "compile",
            "candidateProfile": "native-relink-compile-only",
            "policy": { "id": NATIVE_RELINK_POLICY_ID },
            "nativeRelinkAdapterId": "arduino-avr-native-relink-v1",
            "nativeRelinkContractId": "ck-native-relink-avr-release-compile-only-v2",
            "artifactEquivalencePolicyId": "arduino-avr-hex-required-eeprom-optional-exact-v2",
            "target": {
                "fqbn": "arduino:avr:uno",
                "coreVersion": "1.8.6",
                "cliVersion": cli,
                "toolchainKey": toolchain,
            }
        });
        std::fs::write(
            &report_path,
            serde_json::to_vec(&native_report).expect("native report json"),
        )
        .expect("native report");

        assert!(
            !may_contain_local_performance_certificate(&directory),
            "a NativeRelink v4 certificate must not trigger the v2 CLI hash path"
        );
        let adapter =
            native_relink_adapter_for("arduino:avr:uno", Some("avr")).expect("AVR adapter");
        assert!(may_contain_native_relink_target(
            &directory,
            "arduino:avr:uno",
            "1.8.6",
            cli,
            toolchain,
            adapter,
        ));
        let mut legacy_report = native_report.clone();
        legacy_report["nativeRelinkContractId"] =
            serde_json::Value::String("ck-native-relink-avr-release-compile-only-v1".into());
        std::fs::write(
            &report_path,
            serde_json::to_vec(&legacy_report).expect("legacy report json"),
        )
        .expect("legacy report");
        assert!(
            !may_contain_native_relink_target(
                &directory,
                "arduino:avr:uno",
                "1.8.6",
                cli,
                toolchain,
                adapter,
            ),
            "bounded prefilter must reject a v1 report before any v2 authorization work"
        );
        let mut legacy_policy_report = native_report.clone();
        legacy_policy_report["policy"]["id"] =
            serde_json::Value::String("ck-forge-portable-edit-performance-v2".into());
        std::fs::write(
            &report_path,
            serde_json::to_vec(&legacy_policy_report).expect("legacy policy report json"),
        )
        .expect("legacy policy report");
        assert!(
            !may_contain_native_relink_target(
                &directory,
                "arduino:avr:uno",
                "1.8.6",
                cli,
                toolchain,
                adapter,
            ),
            "a v2 performance policy must never trigger a v3 authorization lookup"
        );
        std::fs::write(
            &report_path,
            serde_json::to_vec(&native_report).expect("restored report json"),
        )
        .expect("restored native report");
        assert!(
            !may_contain_native_relink_target(
                &directory,
                "arduino:avr:nano:cpu=atmega328old",
                "1.8.6",
                cli,
                toolchain,
                adapter,
            ),
            "an Uno report is only a cheap hint for the exact Uno FQBN"
        );

        reset_qualification_cli_file_reads();
        assert!(
            load_local_qualification(
                temp.path(),
                "arduino:avr:nano:cpu=atmega328old",
                "1.8.6",
                cli,
                toolchain,
                &"f".repeat(64),
            )
            .is_none()
        );
        assert_eq!(
            qualification_cli_file_reads(),
            0,
            "a v4-only store must not make the v2 loader read Arduino CLI"
        );
        reset_qualification_cli_file_reads();
        assert!(
            load_local_native_relink_evidence_sha256(
                temp.path(),
                "arduino:avr:nano:cpu=atmega328old",
                "1.8.6",
                cli,
                toolchain,
            )
            .is_none()
        );
        assert_eq!(
            qualification_cli_file_reads(),
            0,
            "an exact-target mismatch must be rejected before reading Arduino CLI"
        );
        reset_qualification_cli_file_reads();
        assert!(
            load_local_native_relink_evidence_sha256(
                temp.path(),
                "arduino:avr:uno",
                "1.8.6",
                cli,
                toolchain,
            )
            .is_none(),
            "the metadata hint alone must never authorize an incomplete fixture"
        );
        assert_eq!(
            qualification_cli_file_reads(),
            1,
            "a matching hint must retain the original strong CLI content-hash path"
        );

        std::fs::write(
            directory.join("certificate.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaId": "ck.forge.local-performance-certificate",
                "schemaVersion": 2,
                "candidateSha256": "c".repeat(64),
                "reportSha256": "d".repeat(64),
                "artifactManifestSha256": "e".repeat(64),
            }))
            .expect("performance certificate json"),
        )
        .expect("performance certificate");
        assert!(may_contain_local_performance_certificate(&directory));
        assert!(
            !may_contain_native_relink_target(
                &directory,
                "arduino:avr:uno",
                "1.8.6",
                cli,
                toolchain,
                adapter,
            ),
            "a v2 performance certificate cannot hint NativeRelink authorization"
        );
        reset_qualification_cli_file_reads();
        assert!(
            load_local_qualification(
                temp.path(),
                "arduino:avr:uno",
                "1.8.6",
                cli,
                toolchain,
                &"f".repeat(64),
            )
            .is_none(),
            "a schema hint cannot replace full candidate/report/artifact validation"
        );
        assert_eq!(
            qualification_cli_file_reads(),
            1,
            "a v2 candidate must continue through the strong CLI content hash"
        );
    }

    #[test]
    fn native_relink_hint_budget_keeps_64_misses_cheap_and_65_falls_back_to_exact_key() {
        let temp = tempfile::tempdir().expect("hint budget tempdir");
        write_test_cli(temp.path());
        let root = temp.path().join("state").join("qualifications");
        std::fs::create_dir_all(&root).expect("qualification root");
        for index in 0..64 {
            std::fs::create_dir(root.join(format!("malformed-sibling-{index:03}")))
                .expect("malformed sibling");
        }
        let canonical_root = root.canonicalize().expect("canonical root");
        let adapter = native_relink_adapter_for(TEST_FQBN, Some("avr")).expect("AVR adapter");
        assert_eq!(
            scan_native_relink_hints(
                &root,
                &canonical_root,
                TEST_FQBN,
                TEST_CORE_VERSION,
                TEST_CLI_VERSION,
                TEST_TOOLCHAIN_KEY,
                adapter,
            ),
            Some(NativeRelinkHintScan::CompleteNoMatch)
        );
        reset_qualification_cli_file_reads();
        assert!(
            load_local_native_relink_evidence_sha256(
                temp.path(),
                TEST_FQBN,
                TEST_CORE_VERSION,
                TEST_CLI_VERSION,
                TEST_TOOLCHAIN_KEY,
            )
            .is_none()
        );
        assert_eq!(
            qualification_cli_file_reads(),
            0,
            "a complete <=64 mismatch must not hash Arduino CLI"
        );

        std::fs::create_dir(root.join("malformed-sibling-064")).expect("65th sibling");
        assert_eq!(
            scan_native_relink_hints(
                &root,
                &canonical_root,
                TEST_FQBN,
                TEST_CORE_VERSION,
                TEST_CLI_VERSION,
                TEST_TOOLCHAIN_KEY,
                adapter,
            ),
            Some(NativeRelinkHintScan::BudgetExceeded)
        );
        reset_qualification_cli_file_reads();
        assert!(
            load_local_native_relink_evidence_sha256(
                temp.path(),
                TEST_FQBN,
                TEST_CORE_VERSION,
                TEST_CLI_VERSION,
                TEST_TOOLCHAIN_KEY,
            )
            .is_none()
        );
        assert_eq!(
            qualification_cli_file_reads(),
            1,
            "an over-budget store must perform one bounded strong-identity lookup, not fail globally"
        );
    }

    #[test]
    fn over_budget_native_relink_store_skips_all_sibling_evidence_parsing() {
        let temp = tempfile::tempdir().expect("over-budget hint tempdir");
        let root = temp.path().join("state").join("qualifications");
        std::fs::create_dir_all(&root).expect("qualification root");
        let adapter = native_relink_adapter_for(TEST_FQBN, Some("avr")).expect("AVR adapter");
        let certificate = serde_json::to_vec(&serde_json::json!({
            "schemaId": LOCAL_QUALIFICATION_SCHEMA_ID,
            "schemaVersion": 4,
            "candidateProfile": NATIVE_RELINK_PROFILE_ID,
            "evidenceSha256": "d".repeat(64),
            "reportSha256": "e".repeat(64)
        }))
        .expect("certificate JSON");
        let report = serde_json::to_vec(&serde_json::json!({
            "schemaId": NATIVE_RELINK_REPORT_SCHEMA_ID,
            "operation": "compile",
            "candidateProfile": NATIVE_RELINK_PROFILE_ID,
            "nativeRelinkAdapterId": adapter.id,
            "nativeRelinkContractId": adapter.engine_contract_id,
            "artifactEquivalencePolicyId": adapter.artifact_policy_id,
            "target": {
                "fqbn": TEST_FQBN,
                "coreVersion": TEST_CORE_VERSION,
                "cliVersion": TEST_CLI_VERSION,
                "toolchainKey": TEST_TOOLCHAIN_KEY
            }
        }))
        .expect("report JSON");
        for index in 0..=MAX_LOCAL_QUALIFICATION_HINT_SCAN {
            let directory = root.join(format!("plausible-sibling-{index:03}"));
            std::fs::create_dir(&directory).expect("plausible sibling");
            std::fs::write(directory.join("certificate.json"), &certificate)
                .expect("sibling certificate");
            std::fs::write(directory.join("report.json"), &report).expect("sibling report");
        }
        let canonical_root = root.canonicalize().expect("canonical root");
        assert_eq!(
            scan_native_relink_hints(
                &root,
                &canonical_root,
                TEST_FQBN,
                TEST_CORE_VERSION,
                TEST_CLI_VERSION,
                TEST_TOOLCHAIN_KEY,
                adapter,
            ),
            Some(NativeRelinkHintScan::BudgetExceeded),
            "a large store must choose exact-key lookup before any plausible sibling can win"
        );
    }

    #[test]
    fn idle_hint_index_shortcuts_large_store_but_never_authorizes_incomplete_evidence() {
        let temp = tempfile::tempdir().expect("preindexed hint tempdir");
        write_test_cli(temp.path());
        let root = temp.path().join("state").join("qualifications");
        std::fs::create_dir_all(&root).expect("qualification root");
        let adapter = native_relink_adapter_for(TEST_FQBN, Some("avr")).expect("AVR adapter");
        let certificate = serde_json::to_vec(&serde_json::json!({
            "schemaId": LOCAL_QUALIFICATION_SCHEMA_ID,
            "schemaVersion": 4,
            "candidateProfile": NATIVE_RELINK_PROFILE_ID,
            "evidenceSha256": "d".repeat(64),
            "reportSha256": "e".repeat(64)
        }))
        .expect("certificate JSON");
        let report = serde_json::to_vec(&serde_json::json!({
            "schemaId": NATIVE_RELINK_REPORT_SCHEMA_ID,
            "operation": "compile",
            "candidateProfile": NATIVE_RELINK_PROFILE_ID,
            "nativeRelinkAdapterId": adapter.id,
            "nativeRelinkContractId": adapter.engine_contract_id,
            "artifactEquivalencePolicyId": adapter.artifact_policy_id,
            "policy": { "id": NATIVE_RELINK_POLICY_ID },
            "target": {
                "fqbn": TEST_FQBN,
                "coreVersion": TEST_CORE_VERSION,
                "cliVersion": TEST_CLI_VERSION,
                "toolchainKey": TEST_TOOLCHAIN_KEY
            }
        }))
        .expect("report JSON");
        for index in 0..=MAX_LOCAL_QUALIFICATION_HINT_SCAN {
            let directory = root.join(format!("preindexed-sibling-{index:03}"));
            std::fs::create_dir(&directory).expect("preindexed sibling");
            std::fs::write(directory.join("certificate.json"), &certificate)
                .expect("sibling certificate");
            std::fs::write(directory.join("report.json"), &report).expect("sibling report");
        }
        let canonical_root = root.canonicalize().expect("canonical root");
        assert!(super::ensure_native_relink_root_hint_index(
            &root,
            &canonical_root
        ));
        assert_eq!(
            scan_native_relink_hints(
                &root,
                &canonical_root,
                TEST_FQBN,
                TEST_CORE_VERSION,
                TEST_CLI_VERSION,
                TEST_TOOLCHAIN_KEY,
                adapter,
            ),
            Some(NativeRelinkHintScan::ExactTargetPresent)
        );
        assert!(
            load_local_native_relink_evidence_sha256(
                temp.path(),
                TEST_FQBN,
                TEST_CORE_VERSION,
                TEST_CLI_VERSION,
                TEST_TOOLCHAIN_KEY,
            )
            .is_none(),
            "a preindexed directory hint must not replace full certificate/evidence validation"
        );
    }

    #[test]
    fn native_relink_lookup_normalizes_menu_order_but_preserves_exact_option_values() {
        let temp = tempfile::tempdir().expect("menu-order qualification fixture");
        // Synthetic certificate parser fixture, not a hardware qualification.
        let canonical = "arduino:avr:test_menu_order:alpha=1,beta=2";
        let reordered = "arduino:avr:test_menu_order:beta=2,alpha=1";
        let (_, evidence_sha256) = write_valid_native_relink_qualification(temp.path(), canonical);
        for fqbn in [canonical, reordered] {
            assert_eq!(
                load_local_native_relink_evidence_sha256(
                    temp.path(), fqbn, TEST_CORE_VERSION, TEST_CLI_VERSION, TEST_TOOLCHAIN_KEY,
                ).as_deref(),
                Some(evidence_sha256.as_str()),
                "only lookup order may change; all certificate checks still run",
            );
        }
        for fqbn in [
            "arduino:avr:test_menu_order:beta=3,alpha=1",
            "arduino:avr:test_menu_order:alpha=1",
            "arduino:avr:test_menu_order:beta=2,alpha=1,alpha=1",
            "arduino:avr:test_menu_order:beta=2, alpha=1",
        ] {
            assert!(load_local_native_relink_evidence_sha256(
                temp.path(), fqbn, TEST_CORE_VERSION, TEST_CLI_VERSION, TEST_TOOLCHAIN_KEY,
            ).is_none(), "changed or malformed target must remain unqualified: {fqbn}");
        }
        let parsed = super::parse_complete_fqbn(reordered).unwrap();
        assert_eq!(parsed.complete, reordered, "never rewrite the compile request");
    }

    #[test]
    fn old_executable_siblings_cannot_hide_or_authorize_the_current_exact_certificate() {
        let temp = tempfile::tempdir().expect("exact qualification tempdir");
        let (qualification_key, evidence_sha256) =
            write_valid_native_relink_qualification(temp.path(), TEST_FQBN);
        let root = temp.path().join("state").join("qualifications");
        for index in 0..80 {
            let old_key = sha256_bytes(format!("old-executable-{index}").as_bytes());
            assert_ne!(old_key, qualification_key);
            let directory = root.join(old_key);
            std::fs::create_dir(&directory).expect("old qualification directory");
            // Plausible target metadata may trigger strong lookup, but cannot
            // authorize because only the exact current binding path is read.
            std::fs::write(
                directory.join("certificate.json"),
                serde_json::to_vec(&serde_json::json!({
                    "schemaId": LOCAL_QUALIFICATION_SCHEMA_ID,
                    "schemaVersion": 4,
                    "candidateProfile": NATIVE_RELINK_PROFILE_ID,
                    "evidenceSha256": "d".repeat(64),
                    "reportSha256": "e".repeat(64)
                }))
                .expect("old certificate JSON"),
            )
            .expect("old certificate");
            std::fs::write(
                directory.join("report.json"),
                serde_json::to_vec(&serde_json::json!({
                    "schemaId": NATIVE_RELINK_REPORT_SCHEMA_ID,
                    "operation": "compile",
                    "candidateProfile": NATIVE_RELINK_PROFILE_ID,
                    "nativeRelinkAdapterId": "arduino-avr-native-relink-v1",
                    "nativeRelinkContractId": CK_FORGE_NATIVE_RELINK_COMPILE_ONLY_CONTRACT_ID,
                    "artifactEquivalencePolicyId": "arduino-avr-hex-required-eeprom-optional-exact-v2",
                    "target": {
                        "fqbn": TEST_FQBN,
                        "coreVersion": TEST_CORE_VERSION,
                        "cliVersion": TEST_CLI_VERSION,
                        "toolchainKey": TEST_TOOLCHAIN_KEY
                    }
                }))
                .expect("old report JSON"),
            )
            .expect("old report");
        }

        assert_eq!(
            load_local_native_relink_evidence_sha256(
                temp.path(),
                TEST_FQBN,
                TEST_CORE_VERSION,
                TEST_CLI_VERSION,
                TEST_TOOLCHAIN_KEY,
            )
            .as_deref(),
            Some(evidence_sha256.as_str()),
            "more than 64 old-executable certificates must not hide the current exact key"
        );
        assert!(
            load_local_native_relink_evidence_sha256(
                temp.path(),
                TEST_FQBN,
                TEST_CORE_VERSION,
                TEST_CLI_VERSION,
                "arduino|avr|1.8.6|different-toolchain",
            )
            .is_none()
        );

        let canonical_root = root.canonicalize().expect("canonical qualification root");
        assert!(
            exact_local_qualification_directory(&root, &canonical_root, "../not-a-key").is_none()
        );
        std::fs::write(
            root.join(&qualification_key).join("certificate.json"),
            b"{malformed",
        )
        .expect("tamper exact certificate");
        assert!(
            load_local_native_relink_evidence_sha256(
                temp.path(),
                TEST_FQBN,
                TEST_CORE_VERSION,
                TEST_CLI_VERSION,
                TEST_TOOLCHAIN_KEY,
            )
            .is_none()
        );
    }
}
