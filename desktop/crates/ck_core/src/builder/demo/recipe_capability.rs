//! Architecture-neutral discovery of replayable Arduino recipe capabilities.
//!
//! This module deliberately does not authorize a Fast route.  It turns a
//! captured native Arduino baseline into a machine-readable observation.  A
//! certificate or production gate must independently bind that observation to
//! a Core, toolchain, complete FQBN and host before executing any recipe.
//!
//! The extractor is fail-closed: malformed or absent expanded properties,
//! compilation database entries, response-file contents, or artifact-role
//! evidence make the affected capability `false`.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

pub const RECIPE_CAPABILITY_SCHEMA_VERSION: u32 = 2;
pub const RECIPE_BUILD_ARTIFACT_MANIFEST_SCHEMA_VERSION: u32 = 1;

const CAP_SKETCH_COMPILE: &str = "sketch_compile";
const CAP_LIBRARY_GRAPH_TRANSITION: &str = "library_graph_transition";
const CAP_CORE_ARCHIVE_REUSE: &str = "core_archive_reuse";
const CAP_DIRECT_LINK: &str = "direct_link";
const CAP_POST_LINK_ARTIFACTS: &str = "post_link_artifacts";
const CAP_UPLOAD_READY: &str = "upload_ready";
const CAP_RESPONSE_FILES: &str = "response_files";
const CAP_PREBUILD_HOOKS: &str = "prebuild_hooks";

/// Boolean projection used by future policy code and evidence reports.
///
/// A `true` value means only that the supplied native baseline contains the
/// bounded evidence described by this module.  It is not Fast authorization.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeCapabilityVector {
    pub sketch_compile: bool,
    pub library_graph_transition: bool,
    pub core_archive_reuse: bool,
    pub direct_link: bool,
    pub post_link_artifacts: bool,
    pub upload_ready: bool,
    pub response_files: bool,
    pub prebuild_hooks: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecipeArtifactRole {
    CoreArchive,
    LinkOutput,
    FirmwareImage,
    /// An image or other top-level artifact materialized by a Core prebuild
    /// hook. It remains distinct from post-link output so a compile-only
    /// observation can account for it without treating it as a DirectLink
    /// prerequisite.
    PrebuildAuxiliary,
    PostLinkAuxiliary,
    UploadPlan,
}

/// One artifact captured from a completed native Arduino baseline.
///
/// `producer_property` and `consumer_properties` name keys in the same
/// expanded-property snapshot.  Hash and non-zero size prevent a mere path
/// declaration from becoming evidence.  `upload_required` is meaningful only
/// when the caller supplies a complete artifact-role manifest (`Some` rather
/// than `None` in [`RecipeCapabilityEvidence::artifacts`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeArtifactEvidence {
    pub role: RecipeArtifactRole,
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub producer_property: String,
    #[serde(default)]
    pub consumer_properties: Vec<String>,
    #[serde(default)]
    pub upload_required: bool,
}

/// Content-addressed response-file evidence captured beside the CCDB.
///
/// Keeping the contents makes nested `@file` references independently
/// checkable without consulting a mutable filesystem during extraction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeResponseFileEvidence {
    pub path: String,
    pub contents: String,
    pub sha256: String,
}

/// Public, serialization-stable projection of the builder's completed
/// `BuildArtifactManifest`.  It intentionally carries no inferred roles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeBuildArtifactIdentity {
    pub relative_path: String,
    pub size: u64,
    pub sha256: String,
    /// Optional producer claim supplied only by an independently authenticated
    /// builder identity. Ordinary final-artifact manifests leave this empty;
    /// the adapter still verifies that the named property is a replayable
    /// Arduino recipe before assigning a role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authenticated_producer_property: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeBuildArtifactManifest {
    pub schema_version: u32,
    pub primary_relative_path: String,
    pub artifacts: Vec<RecipeBuildArtifactIdentity>,
}

/// Conservative result of binding a completed artifact manifest to expanded
/// recipes and a concrete CCDB.  Callers must pass `None` to
/// [`RecipeCapabilityEvidence::artifacts`] unless `complete` is true.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeArtifactRoleAdaptation {
    pub complete: bool,
    pub artifacts: Vec<RecipeArtifactEvidence>,
    pub blockers: Vec<String>,
}

impl RecipeArtifactRoleAdaptation {
    pub fn complete_evidence(&self) -> Option<&[RecipeArtifactEvidence]> {
        self.complete.then_some(self.artifacts.as_slice())
    }
}

/// Inputs taken from one completed native Arduino CLI baseline.
///
/// `artifacts: None` means that no complete artifact-role manifest was
/// captured.  An empty but present manifest is `Some(&[])`; it proves that the
/// baseline declared no artifacts, so artifact-dependent capabilities remain
/// false.  A previous CCDB is required to prove an actual library graph
/// transition rather than guessing one from a single graph.
pub struct RecipeCapabilityEvidence<'a> {
    pub expanded_properties: &'a HashMap<String, String>,
    pub compile_commands_json: &'a str,
    pub previous_compile_commands_json: Option<&'a str>,
    pub artifacts: Option<&'a [RecipeArtifactEvidence]>,
    pub response_files: Option<&'a [RecipeResponseFileEvidence]>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeCapabilityReport {
    pub schema_version: u32,
    pub baseline_sha256: String,
    pub capabilities: RecipeCapabilityVector,
    /// Presence is separate from replayability. A platform with no response
    /// files or prebuild hooks must not be rejected merely because the related
    /// capability is false, while an observed-but-unproven feature must remain
    /// fail-closed.
    pub observed_response_files: bool,
    pub observed_prebuild_hooks: bool,
    /// Reasons are retained even when another prerequisite already failed so
    /// qualification tooling can explain the complete evidence gap.
    pub blockers: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecipeCapabilityCandidateIntent {
    /// Observe whether a controlled PortableFast compile can retain the
    /// platform's native Arduino recipes while using only its compiler-cache
    /// mechanics. This is deliberately not a direct-link authorization: it
    /// proves the concrete sketch command, complete final-artifact role
    /// mapping, and any observed response files, but does not require or
    /// authorize Core archive reuse.
    NativeRecipeCache,
    Compile,
    UploadReady,
}

/// Privacy-preserving, observation-only precondition for a controlled A/B
/// candidate. It never grants a production route or replaces performance,
/// artifact-equivalence, Core/toolchain/FQBN, or host certificates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeCapabilityCandidateAssessment {
    pub schema_version: u32,
    pub baseline_sha256: String,
    pub intent: RecipeCapabilityCandidateIntent,
    pub capabilities: RecipeCapabilityVector,
    pub observed_response_files: bool,
    pub observed_prebuild_hooks: bool,
    pub artifact_roles_complete: bool,
    pub capability_gate_passed: bool,
    pub required_capabilities: Vec<String>,
    pub missing_capabilities: Vec<String>,
    /// Reasons for each missing candidate prerequisite. The field is additive
    /// within schema v2 and defaults empty when older serialized assessments
    /// are read.
    #[serde(default)]
    pub blockers: BTreeMap<String, Vec<String>>,
    pub observation_only: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct CcdbEntry {
    #[serde(default)]
    directory: String,
    #[serde(default)]
    arguments: Vec<String>,
    #[serde(default)]
    command: String,
    #[serde(default)]
    file: String,
    #[serde(default)]
    output: Option<String>,
}

#[derive(Debug, Clone)]
struct CcdbAnalysis {
    sketch_entry_count: usize,
    library_sources: BTreeSet<String>,
    compile_outputs: BTreeSet<String>,
    response_references: Vec<ResponseReference>,
}

#[derive(Debug, Clone)]
struct ResponseReference {
    base_directory: String,
    raw_path: String,
}

#[derive(Debug, Default)]
struct CapabilityDecision {
    available: bool,
    blockers: Vec<String>,
}

impl CapabilityDecision {
    fn yes() -> Self {
        Self {
            available: true,
            blockers: Vec::new(),
        }
    }

    fn no(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            blockers: vec![reason.into()],
        }
    }

    fn require(&mut self, condition: bool, reason: impl Into<String>) {
        if !condition {
            self.available = false;
            self.blockers.push(reason.into());
        }
    }
}

/// Extract a discovery-only capability vector from native Arduino evidence.
pub fn extract_recipe_capabilities(
    evidence: &RecipeCapabilityEvidence<'_>,
) -> RecipeCapabilityReport {
    let current_ccdb = analyze_ccdb(evidence.compile_commands_json, evidence.expanded_properties);

    let sketch_compile = match &current_ccdb {
        Ok(analysis) if analysis.sketch_entry_count == 1 => CapabilityDecision::yes(),
        Ok(analysis) => CapabilityDecision::no(format!(
            "expected exactly one concrete sketch compile command, observed {}",
            analysis.sketch_entry_count
        )),
        Err(reason) => CapabilityDecision::no(reason.clone()),
    };

    let core_archive_reuse = decide_core_archive_reuse(evidence);
    let direct_link = decide_direct_link(evidence, &sketch_compile, &core_archive_reuse);
    let library_graph_transition = decide_library_graph_transition(
        evidence,
        current_ccdb.as_ref().ok(),
        &sketch_compile,
        &core_archive_reuse,
    );
    let post_link_artifacts = decide_post_link_artifacts(evidence, &direct_link);
    let upload_ready = decide_upload_ready(evidence, &post_link_artifacts);
    let response_files = match &current_ccdb {
        Ok(analysis) => decide_response_files(evidence, analysis),
        Err(reason) => CapabilityDecision::no(format!(
            "response-file evidence cannot be bound to an invalid CCDB: {reason}"
        )),
    };
    let effective_prebuild_hooks =
        effective_prebuild_hook_keys(evidence.expanded_properties, cfg!(windows));
    let prebuild_hooks =
        decide_prebuild_hooks(evidence.expanded_properties, &effective_prebuild_hooks);
    let observed_response_files = current_ccdb
        .as_ref()
        .is_ok_and(|analysis| !analysis.response_references.is_empty());
    let observed_prebuild_hooks = !effective_prebuild_hooks.is_empty();

    let capabilities = RecipeCapabilityVector {
        sketch_compile: sketch_compile.available,
        library_graph_transition: library_graph_transition.available,
        core_archive_reuse: core_archive_reuse.available,
        direct_link: direct_link.available,
        post_link_artifacts: post_link_artifacts.available,
        upload_ready: upload_ready.available,
        response_files: response_files.available,
        prebuild_hooks: prebuild_hooks.available,
    };

    let mut blockers = BTreeMap::new();
    for (name, decision) in [
        (CAP_SKETCH_COMPILE, sketch_compile),
        (CAP_LIBRARY_GRAPH_TRANSITION, library_graph_transition),
        (CAP_CORE_ARCHIVE_REUSE, core_archive_reuse),
        (CAP_DIRECT_LINK, direct_link),
        (CAP_POST_LINK_ARTIFACTS, post_link_artifacts),
        (CAP_UPLOAD_READY, upload_ready),
        (CAP_RESPONSE_FILES, response_files),
        (CAP_PREBUILD_HOOKS, prebuild_hooks),
    ] {
        if !decision.blockers.is_empty() {
            blockers.insert(name.to_string(), decision.blockers);
        }
    }

    RecipeCapabilityReport {
        schema_version: RECIPE_CAPABILITY_SCHEMA_VERSION,
        baseline_sha256: baseline_fingerprint(evidence),
        capabilities,
        observed_response_files,
        observed_prebuild_hooks,
        blockers,
    }
}

/// Evaluate only the recipe-evidence prerequisite for a controlled A/B run.
///
/// A host-effective prebuild hook is required only when one was observed. Its
/// capability is proven by the same fully resolved recipe evidence retained in
/// the report; inactive host variants cannot block or authorize the candidate.
pub fn assess_recipe_capability_candidate(
    report: &RecipeCapabilityReport,
    artifact_roles_complete: bool,
    intent: RecipeCapabilityCandidateIntent,
) -> RecipeCapabilityCandidateAssessment {
    let mut required = match intent {
        // PortableFast keeps the Core's native compile/link/hooks path. Its
        // controlled observation must prove that the captured sketch command
        // and complete artifact mapping are real, but Core archive reuse and
        // direct-link replay are intentionally irrelevant here.
        RecipeCapabilityCandidateIntent::NativeRecipeCache => vec![
            CAP_SKETCH_COMPILE.to_string(),
            "artifact_roles_complete".to_string(),
        ],
        RecipeCapabilityCandidateIntent::Compile | RecipeCapabilityCandidateIntent::UploadReady => {
            vec![
                CAP_SKETCH_COMPILE.to_string(),
                CAP_CORE_ARCHIVE_REUSE.to_string(),
                CAP_DIRECT_LINK.to_string(),
                "artifact_roles_complete".to_string(),
            ]
        }
    };
    if intent == RecipeCapabilityCandidateIntent::UploadReady {
        required.push(CAP_POST_LINK_ARTIFACTS.to_string());
        required.push(CAP_UPLOAD_READY.to_string());
    }
    if report.observed_response_files {
        required.push(CAP_RESPONSE_FILES.to_string());
    }
    if report.observed_prebuild_hooks
        && intent != RecipeCapabilityCandidateIntent::NativeRecipeCache
    {
        required.push(CAP_PREBUILD_HOOKS.to_string());
    }

    let available = |name: &str| match name {
        CAP_SKETCH_COMPILE => report.capabilities.sketch_compile,
        CAP_CORE_ARCHIVE_REUSE => report.capabilities.core_archive_reuse,
        CAP_DIRECT_LINK => report.capabilities.direct_link,
        CAP_POST_LINK_ARTIFACTS => report.capabilities.post_link_artifacts,
        CAP_UPLOAD_READY => report.capabilities.upload_ready,
        CAP_RESPONSE_FILES => report.capabilities.response_files,
        CAP_PREBUILD_HOOKS => report.capabilities.prebuild_hooks,
        "artifact_roles_complete" => artifact_roles_complete,
        _ => false,
    };
    let missing = required
        .iter()
        .filter(|name| !available(name))
        .cloned()
        .collect::<Vec<_>>();
    let blockers = missing
        .iter()
        .map(|name| {
            let reasons = if name == "artifact_roles_complete" {
                vec!["artifact role adaptation is incomplete".to_string()]
            } else {
                report
                    .blockers
                    .get(name)
                    .filter(|reasons| !reasons.is_empty())
                    .cloned()
                    .unwrap_or_else(|| vec![format!("{name} capability was not proven")])
            };
            (name.clone(), reasons)
        })
        .collect();

    RecipeCapabilityCandidateAssessment {
        schema_version: RECIPE_CAPABILITY_SCHEMA_VERSION,
        baseline_sha256: report.baseline_sha256.clone(),
        intent,
        capabilities: report.capabilities.clone(),
        observed_response_files: report.observed_response_files,
        observed_prebuild_hooks: report.observed_prebuild_hooks,
        artifact_roles_complete,
        capability_gate_passed: missing.is_empty(),
        required_capabilities: required,
        missing_capabilities: missing,
        blockers,
        observation_only: true,
    }
}

/// Bind a completed Arduino artifact manifest to actual expanded recipe paths.
///
/// No role is inferred from a file extension, FQBN, architecture, board name,
/// tool executable, or argument position.  The primary manifest artifact must
/// be named by exactly one combine recipe.  For archive and post-link recipes,
/// a producer is accepted only when that recipe names exactly one currently
/// unassigned manifest artifact.  Any ambiguity leaves the adaptation
/// incomplete, which keeps all artifact-dependent capabilities closed.
pub fn adapt_artifact_roles_from_baseline(
    expanded_properties: &HashMap<String, String>,
    compile_commands_json: &str,
    build_path: &Path,
    manifest: &RecipeBuildArtifactManifest,
) -> RecipeArtifactRoleAdaptation {
    let mut blockers = BTreeSet::new();
    let Some(build_key) = normalize_evidence_path("", &build_path.to_string_lossy()) else {
        return incomplete_artifact_adaptation("build path is not a normalized absolute path");
    };
    if !is_absolute_evidence_path(&build_key) {
        return incomplete_artifact_adaptation("build path is not absolute");
    }
    if manifest.schema_version != RECIPE_BUILD_ARTIFACT_MANIFEST_SCHEMA_VERSION {
        blockers.insert(format!(
            "artifact manifest schema {} is unsupported",
            manifest.schema_version
        ));
    }
    if manifest.artifacts.is_empty() {
        blockers.insert("artifact manifest is empty".to_string());
    }

    let ccdb = match analyze_ccdb(compile_commands_json, expanded_properties) {
        Ok(ccdb) if ccdb.sketch_entry_count == 1 => Some(ccdb),
        Ok(ccdb) => {
            blockers.insert(format!(
                "CCDB must contain exactly one sketch command, observed {}",
                ccdb.sketch_entry_count
            ));
            None
        }
        Err(reason) => {
            blockers.insert(format!("CCDB cannot bind artifact roles: {reason}"));
            None
        }
    };

    let mut paths = Vec::with_capacity(manifest.artifacts.len());
    let mut seen_paths = HashSet::new();
    for artifact in &manifest.artifacts {
        let relative = normalize_slashes(artifact.relative_path.trim());
        let path = if relative.is_empty()
            || is_absolute_evidence_path(&relative)
            || relative.split('/').any(|component| component == "..")
        {
            blockers.insert(format!(
                "artifact relative path is unsafe: {}",
                artifact.relative_path
            ));
            None
        } else {
            normalize_evidence_path(&build_key, &relative)
        };
        let Some(path) = path else {
            blockers.insert(format!(
                "artifact path cannot be normalized: {}",
                artifact.relative_path
            ));
            paths.push(None);
            continue;
        };
        if !path_is_within(&path, &build_key) {
            blockers.insert(format!("artifact escaped the build path: {path}"));
            paths.push(None);
            continue;
        }
        if !seen_paths.insert(path.to_ascii_lowercase()) {
            blockers.insert(format!("artifact path is duplicated: {path}"));
        }
        if artifact.size == 0 || !is_sha256(&artifact.sha256) {
            blockers.insert(format!("artifact identity is invalid: {path}"));
        }
        if ccdb
            .as_ref()
            .is_some_and(|ccdb| ccdb.compile_outputs.contains(&path.to_ascii_lowercase()))
        {
            blockers.insert(format!(
                "artifact path is also a CCDB compile output and has no unique final role: {path}"
            ));
        }
        paths.push(Some(path));
    }

    let primary_indices = manifest
        .artifacts
        .iter()
        .enumerate()
        .filter_map(|(index, artifact)| {
            (artifact.relative_path == manifest.primary_relative_path).then_some(index)
        })
        .collect::<Vec<_>>();
    if primary_indices.len() != 1 {
        blockers.insert(format!(
            "primary artifact must identify exactly one manifest entry, observed {}",
            primary_indices.len()
        ));
    }

    let mut assignments: Vec<Option<(RecipeArtifactRole, String)>> =
        vec![None; manifest.artifacts.len()];
    for (index, artifact) in manifest.artifacts.iter().enumerate() {
        let Some(producer) = artifact.authenticated_producer_property.as_deref() else {
            continue;
        };
        let Some(path) = paths.get(index).and_then(Option::as_deref) else {
            continue;
        };
        let (role, allowed_placeholders, output_placeholder) = if is_archive_recipe_key(producer) {
            (
                RecipeArtifactRole::CoreArchive,
                &["archive_file", "archive_file_path", "object_file"][..],
                Some("{archive_file_path}"),
            )
        } else {
            blockers.insert(format!(
                "authenticated producer property has no supported role: {producer}"
            ));
            continue;
        };
        if !property_recipe_is_replayable(expanded_properties, producer, allowed_placeholders) {
            blockers.insert(format!(
                "authenticated producer property is missing or not replayable: {producer}"
            ));
            continue;
        }
        let recipe = expanded_properties
            .get(producer)
            .map(String::as_str)
            .unwrap_or_default();
        if !property_recipe_mentions_artifact(expanded_properties, producer, path)
            && output_placeholder.is_none_or(|placeholder| !recipe.contains(placeholder))
        {
            blockers.insert(format!(
                "authenticated producer {producer} neither names {path} nor declares its output placeholder"
            ));
            continue;
        }
        assignments[index] = Some((role, producer.to_string()));
    }
    if let Some(&primary_index) = primary_indices.first()
        && let Some(primary_path) = paths.get(primary_index).and_then(Option::as_deref)
    {
        if assignments[primary_index].is_some() {
            blockers.insert(
                "primary link artifact cannot carry an intermediate producer claim".to_string(),
            );
        }
        let producers = matching_recipe_properties(
            expanded_properties,
            primary_path,
            is_combine_recipe_key,
            &["object_files", "archive_file", "archive_file_path"],
        );
        if producers.len() == 1 {
            assignments[primary_index] =
                Some((RecipeArtifactRole::LinkOutput, producers[0].clone()));
        } else {
            blockers.insert(format!(
                "primary artifact {primary_path} has {} concrete combine producers",
                producers.len()
            ));
        }
    }

    // An archive recipe may mention object inputs too. Restrict matching to
    // paths in the explicit artifact manifest and require one unassigned
    // artifact per recipe before assigning the CoreArchive role.
    assign_unique_recipe_outputs(
        expanded_properties,
        &paths,
        &mut assignments,
        is_archive_recipe_key,
        &["archive_file", "archive_file_path", "object_file"],
        RecipeArtifactRole::CoreArchive,
        "archive",
        &mut blockers,
    );

    // ESP32 and other Cores can materialize a bootloader or configuration
    // image before the sketch is linked. Use only the host-effective prebuild
    // patterns, so an inactive platform variant cannot create ambiguity.
    assign_effective_prebuild_recipe_outputs(
        expanded_properties,
        &paths,
        &mut assignments,
        RecipeArtifactRole::PrebuildAuxiliary,
        "prebuild",
        &mut blockers,
    );

    assign_unique_recipe_outputs(
        expanded_properties,
        &paths,
        &mut assignments,
        is_post_link_recipe_key,
        &[],
        RecipeArtifactRole::PostLinkAuxiliary,
        "post-link",
        &mut blockers,
    );

    let mut output = Vec::new();
    for (index, artifact) in manifest.artifacts.iter().enumerate() {
        let Some(path) = paths.get(index).and_then(Option::as_ref) else {
            continue;
        };
        let Some((mut role, producer_property)) = assignments[index].clone() else {
            blockers.insert(format!(
                "artifact has no unique recipe-derived producer: {path}"
            ));
            continue;
        };
        let consumers = matching_recipe_properties(
            expanded_properties,
            path,
            is_upload_recipe_key,
            &[
                "serial.port",
                "serial.port.file",
                "upload.verbose",
                "upload.verify",
            ],
        );
        if role == RecipeArtifactRole::PostLinkAuxiliary && !consumers.is_empty() {
            role = RecipeArtifactRole::FirmwareImage;
        }
        output.push(RecipeArtifactEvidence {
            role,
            path: path.clone(),
            size: artifact.size,
            sha256: artifact.sha256.clone(),
            producer_property,
            upload_required: !consumers.is_empty(),
            consumer_properties: consumers,
        });
    }
    output.sort_by(|left, right| left.path.cmp(&right.path));

    RecipeArtifactRoleAdaptation {
        complete: blockers.is_empty() && output.len() == manifest.artifacts.len(),
        artifacts: output,
        blockers: blockers.into_iter().collect(),
    }
}

fn incomplete_artifact_adaptation(reason: impl Into<String>) -> RecipeArtifactRoleAdaptation {
    RecipeArtifactRoleAdaptation {
        complete: false,
        artifacts: Vec::new(),
        blockers: vec![reason.into()],
    }
}

fn assign_unique_recipe_outputs(
    props: &HashMap<String, String>,
    paths: &[Option<String>],
    assignments: &mut [Option<(RecipeArtifactRole, String)>],
    key_predicate: fn(&str) -> bool,
    allowed_placeholders: &[&str],
    role: RecipeArtifactRole,
    label: &str,
    blockers: &mut BTreeSet<String>,
) {
    let keys = props
        .keys()
        .filter(|key| key_predicate(key))
        .cloned()
        .collect::<Vec<_>>();
    assign_unique_recipe_outputs_for_keys(
        props,
        paths,
        assignments,
        keys,
        allowed_placeholders,
        role,
        label,
        blockers,
    );
}

fn assign_effective_prebuild_recipe_outputs(
    props: &HashMap<String, String>,
    paths: &[Option<String>],
    assignments: &mut [Option<(RecipeArtifactRole, String)>],
    role: RecipeArtifactRole,
    label: &str,
    blockers: &mut BTreeSet<String>,
) {
    assign_unique_recipe_outputs_for_keys(
        props,
        paths,
        assignments,
        effective_prebuild_hook_keys(props, cfg!(windows)),
        &[],
        role,
        label,
        blockers,
    );
}

fn assign_unique_recipe_outputs_for_keys(
    props: &HashMap<String, String>,
    paths: &[Option<String>],
    assignments: &mut [Option<(RecipeArtifactRole, String)>],
    keys: Vec<String>,
    allowed_placeholders: &[&str],
    role: RecipeArtifactRole,
    label: &str,
    blockers: &mut BTreeSet<String>,
) {
    let mut recipe_to_artifacts = BTreeMap::<String, Vec<usize>>::new();
    for key in keys {
        if !property_recipe_is_replayable(props, &key, allowed_placeholders) {
            continue;
        }
        let matches = paths
            .iter()
            .enumerate()
            .filter_map(|(index, path)| {
                (assignments[index].is_none()
                    && path
                        .as_deref()
                        .is_some_and(|path| property_recipe_produces_artifact(props, &key, path)))
                .then_some(index)
            })
            .collect::<Vec<_>>();
        if !matches.is_empty() {
            recipe_to_artifacts.insert(key, matches);
        }
    }

    let mut artifact_to_recipes = BTreeMap::<usize, Vec<String>>::new();
    for (recipe, artifacts) in recipe_to_artifacts {
        if artifacts.len() != 1 {
            blockers.insert(format!(
                "{label} recipe {recipe} mentions {} unassigned manifest artifacts",
                artifacts.len()
            ));
            continue;
        }
        artifact_to_recipes
            .entry(artifacts[0])
            .or_default()
            .push(recipe);
    }
    for (artifact, recipes) in artifact_to_recipes {
        if recipes.len() == 1 {
            assignments[artifact] = Some((role.clone(), recipes[0].clone()));
        } else {
            let path = paths[artifact].as_deref().unwrap_or("<invalid>");
            blockers.insert(format!(
                "artifact {path} has {} possible {label} producers",
                recipes.len()
            ));
        }
    }
}

fn matching_recipe_properties(
    props: &HashMap<String, String>,
    artifact_path: &str,
    key_predicate: fn(&str) -> bool,
    allowed_placeholders: &[&str],
) -> Vec<String> {
    let mut keys = props
        .keys()
        .filter(|key| key_predicate(key))
        .filter(|key| property_recipe_is_replayable(props, key, allowed_placeholders))
        .filter(|key| property_recipe_mentions_artifact(props, key, artifact_path))
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    keys
}

/// A recipe can mention both its output and several already-materialized input
/// images. Prefer explicit output switches when a Core supplies them; falling
/// back to exact path matching preserves support for recipes whose only safe
/// evidence is a single unique manifest path.
fn property_recipe_produces_artifact(
    props: &HashMap<String, String>,
    key: &str,
    artifact_path: &str,
) -> bool {
    let Some(recipe) = props.get(key) else {
        return false;
    };
    let Some(artifact) = normalize_evidence_path("", artifact_path) else {
        return false;
    };
    let outputs = explicit_recipe_outputs(recipe);
    if outputs.is_empty() {
        return property_recipe_mentions_artifact(props, key, artifact_path);
    }
    outputs.into_iter().any(|output| {
        normalize_evidence_path("", &output)
            .is_some_and(|output| output.eq_ignore_ascii_case(&artifact))
    })
}

fn explicit_recipe_outputs(recipe: &str) -> Vec<String> {
    let Ok(tokens) = split_command_line(recipe) else {
        return Vec::new();
    };
    let mut outputs = Vec::new();
    let mut index = 0usize;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        if matches!(token, "-o" | "--output") {
            if let Some(output) = tokens
                .get(index + 1)
                .filter(|value| !value.trim().is_empty())
            {
                outputs.push(output.clone());
            }
            index += 2;
            continue;
        }
        if let Some(output) = token
            .strip_prefix("--output=")
            .filter(|value| !value.trim().is_empty())
        {
            outputs.push(output.to_string());
        } else if let Some(output) = token
            .strip_prefix("-o")
            .filter(|value| !value.trim().is_empty())
        {
            outputs.push(output.to_string());
        }
        index += 1;
    }
    outputs
}

fn path_is_within(path: &str, root: &str) -> bool {
    let path = path.to_ascii_lowercase();
    let root = root.trim_end_matches('/').to_ascii_lowercase();
    path == root || path.starts_with(&format!("{root}/"))
}

fn decide_core_archive_reuse(evidence: &RecipeCapabilityEvidence<'_>) -> CapabilityDecision {
    let Some(artifacts) = evidence.artifacts else {
        return CapabilityDecision::no("complete artifact-role evidence is missing");
    };
    let cores = artifacts
        .iter()
        .filter(|artifact| artifact.role == RecipeArtifactRole::CoreArchive)
        .collect::<Vec<_>>();
    if cores.len() != 1 {
        return CapabilityDecision::no(format!(
            "expected exactly one Core archive role, observed {}",
            cores.len()
        ));
    }
    let core = cores[0];
    let mut decision = CapabilityDecision::yes();
    decision.require(
        artifact_identity_is_valid(core),
        "Core archive identity is missing, empty, or malformed",
    );
    decision.require(
        is_archive_recipe_key(&core.producer_property),
        "Core archive producer is not an Arduino archive recipe",
    );
    decision.require(
        property_recipe_is_replayable(
            evidence.expanded_properties,
            &core.producer_property,
            &["archive_file", "archive_file_path", "object_file"],
        ),
        "Core archive recipe is missing or contains unsupported placeholders",
    );
    decision
}

fn decide_direct_link(
    evidence: &RecipeCapabilityEvidence<'_>,
    sketch_compile: &CapabilityDecision,
    core_archive_reuse: &CapabilityDecision,
) -> CapabilityDecision {
    let mut decision = CapabilityDecision::yes();
    decision.require(
        sketch_compile.available,
        "a concrete sketch compile command is required",
    );
    decision.require(
        core_archive_reuse.available,
        "a verified reusable Core archive is required",
    );
    let Some(artifacts) = evidence.artifacts else {
        decision.require(false, "complete artifact-role evidence is missing");
        return decision;
    };
    let links = artifacts
        .iter()
        .filter(|artifact| artifact.role == RecipeArtifactRole::LinkOutput)
        .collect::<Vec<_>>();
    decision.require(
        links.len() == 1,
        format!(
            "expected exactly one link output role, observed {}",
            links.len()
        ),
    );
    let Some(link) = links.first() else {
        return decision;
    };
    decision.require(
        artifact_identity_is_valid(link),
        "link output identity is missing, empty, or malformed",
    );
    decision.require(
        is_combine_recipe_key(&link.producer_property),
        "link output producer is not recipe.c.combine.pattern",
    );
    decision.require(
        property_recipe_is_replayable(
            evidence.expanded_properties,
            &link.producer_property,
            &["object_files", "archive_file", "archive_file_path"],
        ),
        "link recipe is missing or contains unsupported placeholders",
    );
    decision.require(
        property_recipe_mentions_artifact(
            evidence.expanded_properties,
            &link.producer_property,
            &link.path,
        ),
        "link recipe does not name the captured link output",
    );
    decision
}

fn decide_library_graph_transition(
    evidence: &RecipeCapabilityEvidence<'_>,
    current: Option<&CcdbAnalysis>,
    sketch_compile: &CapabilityDecision,
    core_archive_reuse: &CapabilityDecision,
) -> CapabilityDecision {
    let mut decision = CapabilityDecision::yes();
    decision.require(
        sketch_compile.available,
        "the current CCDB lacks a concrete sketch command",
    );
    decision.require(
        core_archive_reuse.available,
        "a verified archive recipe and Core archive are required",
    );
    let Some(current) = current else {
        decision.require(false, "the current CCDB is invalid");
        return decision;
    };
    let Some(previous_raw) = evidence.previous_compile_commands_json else {
        decision.require(false, "a previous native CCDB is required");
        return decision;
    };
    let previous = match analyze_ccdb(previous_raw, evidence.expanded_properties) {
        Ok(previous) => previous,
        Err(reason) => {
            decision.require(false, format!("previous CCDB is invalid: {reason}"));
            return decision;
        }
    };
    decision.require(
        previous.sketch_entry_count == 1,
        "the previous CCDB lacks exactly one concrete sketch command",
    );
    decision.require(
        previous.library_sources != current.library_sources,
        "the two native CCDBs do not prove a library graph transition",
    );
    decision
}

fn decide_post_link_artifacts(
    evidence: &RecipeCapabilityEvidence<'_>,
    direct_link: &CapabilityDecision,
) -> CapabilityDecision {
    let mut decision = CapabilityDecision::yes();
    decision.require(
        direct_link.available,
        "verified direct-link evidence is required",
    );
    let Some(artifacts) = evidence.artifacts else {
        decision.require(false, "complete artifact-role evidence is missing");
        return decision;
    };
    let post_link = artifacts
        .iter()
        .filter(|artifact| {
            matches!(
                artifact.role,
                RecipeArtifactRole::FirmwareImage
                    | RecipeArtifactRole::PostLinkAuxiliary
                    | RecipeArtifactRole::UploadPlan
            )
        })
        .collect::<Vec<_>>();
    decision.require(
        !post_link.is_empty(),
        "no post-link artifact roles were captured",
    );
    for artifact in post_link {
        decision.require(
            artifact_identity_is_valid(artifact),
            format!("post-link artifact {} has no valid identity", artifact.path),
        );
        decision.require(
            is_post_link_recipe_key(&artifact.producer_property),
            format!(
                "post-link artifact {} has an unsupported producer property",
                artifact.path
            ),
        );
        decision.require(
            property_recipe_is_replayable(
                evidence.expanded_properties,
                &artifact.producer_property,
                &[],
            ),
            format!(
                "post-link producer {} is missing or unresolved",
                artifact.producer_property
            ),
        );
        decision.require(
            property_recipe_mentions_artifact(
                evidence.expanded_properties,
                &artifact.producer_property,
                &artifact.path,
            ),
            format!(
                "post-link producer {} does not name {}",
                artifact.producer_property, artifact.path
            ),
        );
    }
    decision
}

fn decide_upload_ready(
    evidence: &RecipeCapabilityEvidence<'_>,
    post_link_artifacts: &CapabilityDecision,
) -> CapabilityDecision {
    let mut decision = CapabilityDecision::yes();
    decision.require(
        post_link_artifacts.available,
        "verified post-link artifacts are required",
    );
    let Some(artifacts) = evidence.artifacts else {
        decision.require(false, "complete artifact-role evidence is missing");
        return decision;
    };
    let required = artifacts
        .iter()
        .filter(|artifact| artifact.upload_required)
        .collect::<Vec<_>>();
    decision.require(
        !required.is_empty(),
        "the complete artifact manifest declares no upload-required role",
    );
    for artifact in required {
        decision.require(
            artifact_identity_is_valid(artifact),
            format!("upload artifact {} has no valid identity", artifact.path),
        );
        let upload_consumers = artifact
            .consumer_properties
            .iter()
            .filter(|key| is_upload_recipe_key(key))
            .collect::<Vec<_>>();
        decision.require(
            !upload_consumers.is_empty(),
            format!(
                "upload artifact {} has no upload recipe consumer",
                artifact.path
            ),
        );
        for consumer in upload_consumers {
            decision.require(
                property_recipe_is_replayable(
                    evidence.expanded_properties,
                    consumer,
                    &[
                        "serial.port",
                        "serial.port.file",
                        "upload.verbose",
                        "upload.verify",
                    ],
                ),
                format!("upload consumer {consumer} is missing or unresolved"),
            );
            decision.require(
                property_recipe_mentions_artifact(
                    evidence.expanded_properties,
                    consumer,
                    &artifact.path,
                ),
                format!("upload consumer {consumer} does not name {}", artifact.path),
            );
        }
    }
    decision
}

fn decide_response_files(
    evidence: &RecipeCapabilityEvidence<'_>,
    ccdb: &CcdbAnalysis,
) -> CapabilityDecision {
    if ccdb.response_references.is_empty() {
        return CapabilityDecision::no("the native CCDB contains no response-file references");
    }
    let Some(files) = evidence.response_files else {
        return CapabilityDecision::no("response-file contents were not captured");
    };
    let mut by_path = HashMap::new();
    let mut decision = CapabilityDecision::yes();
    for file in files {
        let Some(path) = normalize_evidence_path("", &file.path) else {
            decision.require(
                false,
                format!("response-file path is invalid: {}", file.path),
            );
            continue;
        };
        let path = response_evidence_path_key(&path);
        let actual_hash = hex::encode(Sha256::digest(file.contents.as_bytes()));
        decision.require(
            is_sha256(&file.sha256) && actual_hash == file.sha256,
            format!("response-file hash is invalid for {}", file.path),
        );
        if by_path.insert(path.clone(), file).is_some() {
            decision.require(
                false,
                format!("duplicate response-file evidence for {path}"),
            );
        }
    }

    let mut verified = HashSet::new();
    let mut attempted = HashSet::new();
    for reference in &ccdb.response_references {
        let Some(path) = normalize_evidence_path(&reference.base_directory, &reference.raw_path)
        else {
            decision.require(
                false,
                format!("invalid response-file reference: {}", reference.raw_path),
            );
            continue;
        };
        let path = response_evidence_path_key(&path);
        if !attempted.insert(path.clone()) {
            continue;
        }
        if let Err(reason) =
            verify_response_file_tree(&path, &by_path, &mut verified, &mut Vec::new())
        {
            decision.require(false, reason);
        }
    }
    decision
}

fn verify_response_file_tree(
    path: &str,
    by_path: &HashMap<String, &RecipeResponseFileEvidence>,
    verified: &mut HashSet<String>,
    stack: &mut Vec<String>,
) -> Result<(), String> {
    if verified.contains(path) {
        return Ok(());
    }
    if stack.iter().any(|entry| entry == path) {
        return Err(format!("response-file cycle detected at {path}"));
    }
    let file = by_path
        .get(path)
        .ok_or_else(|| format!("response-file evidence is missing for {path}"))?;
    if !is_sha256(&file.sha256)
        || hex::encode(Sha256::digest(file.contents.as_bytes())) != file.sha256
    {
        return Err(format!("response-file evidence changed for {path}"));
    }
    stack.push(path.to_string());
    let base = path.rsplit_once('/').map(|(base, _)| base).unwrap_or("");
    for token in split_response_file_contents(&file.contents)
        .map_err(|reason| format!("response-file {path} is invalid: {reason}"))?
    {
        let Some(nested) = response_path_from_token(&token) else {
            continue;
        };
        let nested = normalize_evidence_path(base, &nested)
            .ok_or_else(|| format!("invalid nested response-file reference in {path}"))?;
        let nested = response_evidence_path_key(&nested);
        verify_response_file_tree(&nested, by_path, verified, stack)?;
    }
    stack.pop();
    verified.insert(path.to_string());
    Ok(())
}

fn response_evidence_path_key(path: &str) -> String {
    // A captured Windows path is canonicalized by the builder into a
    // case-insensitive identity. CCDB arguments retain the Core recipe's
    // original spelling, so compare drive-qualified paths with Windows path
    // semantics even when the evidence is inspected on another host.
    if path.as_bytes().get(1) == Some(&b':') && path.as_bytes().get(2) == Some(&b'/') {
        path.to_ascii_lowercase()
    } else {
        path.to_string()
    }
}

fn decide_prebuild_hooks(props: &HashMap<String, String>, hooks: &[String]) -> CapabilityDecision {
    if hooks.is_empty() {
        return CapabilityDecision::no("no prebuild hook recipe was observed");
    }
    let mut decision = CapabilityDecision::yes();
    for key in hooks {
        decision.require(
            property_recipe_is_replayable(props, key, &[]),
            format!("prebuild hook {key} contains unresolved placeholders"),
        );
    }
    decision
}

fn analyze_ccdb(raw: &str, props: &HashMap<String, String>) -> Result<CcdbAnalysis, String> {
    if raw.trim().is_empty() {
        return Err("compile_commands.json evidence is missing".into());
    }
    let entries: Vec<CcdbEntry> =
        serde_json::from_str(raw).map_err(|_| "compile_commands.json is invalid".to_string())?;
    if entries.is_empty() {
        return Err("compile_commands.json has no entries".into());
    }
    let project_name = props
        .get("build.project_name")
        .map(|value| value.trim().trim_matches('"'))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "expanded build.project_name is missing".to_string())?;
    if contains_placeholder(project_name) {
        return Err("expanded build.project_name is unresolved".into());
    }
    let project_basename = normalized_basename(project_name);
    let expected_sketch = format!("{project_basename}.cpp").to_ascii_lowercase();

    let mut sketch_entry_count = 0usize;
    let mut library_sources = BTreeSet::new();
    let mut compile_outputs = BTreeSet::new();
    let mut response_references = Vec::new();
    for entry in entries {
        let file = entry.file.trim();
        if file.is_empty() || contains_placeholder(file) {
            return Err("CCDB entry has a missing or unresolved source path".into());
        }
        let tokens = ccdb_tokens(&entry)?;
        if tokens.iter().any(|token| contains_placeholder(token)) {
            return Err(format!(
                "CCDB command for {file} contains unresolved placeholders"
            ));
        }
        let output = entry
            .output
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| output_from_tokens(&tokens));
        if output.as_deref().is_none_or(contains_placeholder) {
            return Err(format!("CCDB command for {file} has no concrete output"));
        }
        let output = output.expect("concrete output was checked above");
        let output = normalize_evidence_path(&entry.directory, &output)
            .ok_or_else(|| format!("CCDB command for {file} has an invalid output path"))?;
        compile_outputs.insert(output.to_ascii_lowercase());
        let file_key = normalize_slashes(file).to_ascii_lowercase();
        if normalized_basename(&file_key).eq_ignore_ascii_case(&expected_sketch) {
            sketch_entry_count += 1;
        } else if file_key.contains("/libraries/") {
            library_sources.insert(file_key);
        }
        for token in &tokens {
            if let Some(raw_path) = response_path_from_token(token) {
                response_references.push(ResponseReference {
                    base_directory: entry.directory.clone(),
                    raw_path,
                });
            }
        }
    }
    Ok(CcdbAnalysis {
        sketch_entry_count,
        library_sources,
        compile_outputs,
        response_references,
    })
}

fn ccdb_tokens(entry: &CcdbEntry) -> Result<Vec<String>, String> {
    if !entry.arguments.is_empty() {
        return Ok(entry.arguments.clone());
    }
    if entry.command.trim().is_empty() {
        return Err(format!("CCDB command for {} is missing", entry.file));
    }
    split_command_line(&entry.command)
}

fn split_command_line(raw: &str) -> Result<Vec<String>, String> {
    split_quoted_tokens(raw, false)
}

fn split_quoted_tokens(
    raw: &str,
    allow_escaped_quote_outside: bool,
) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\'
            && quote.is_none()
            && allow_escaped_quote_outside
            && chars.peek() == Some(&'"')
        {
            current.push(chars.next().expect("peeked character is present"));
            continue;
        }
        if ch == '\\' && quote == Some('"') {
            // A quoted Windows path contains ordinary backslashes. Only
            // consume one as an escape before a quote or another backslash.
            if chars.peek().is_some_and(|next| matches!(next, '"' | '\\')) {
                current.push(chars.next().expect("peeked character is present"));
            } else {
                current.push(ch);
            }
            continue;
        }
        if matches!(ch, '\'' | '"') {
            if quote == Some(ch) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(ch);
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch.is_whitespace() && quote.is_none() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if quote.is_some() {
        return Err("command line has an unterminated quote".into());
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    if tokens.is_empty() {
        return Err("command line has no tokens".into());
    }
    Ok(tokens)
}

fn split_response_file_contents(raw: &str) -> Result<Vec<String>, String> {
    if raw.trim().is_empty() {
        Ok(Vec::new())
    } else {
        split_quoted_tokens(raw, true)
    }
}

fn output_from_tokens(tokens: &[String]) -> Option<String> {
    tokens
        .windows(2)
        .rev()
        .find(|pair| pair[0] == "-o")
        .map(|pair| pair[1].clone())
}

fn response_path_from_token(token: &str) -> Option<String> {
    let path = token
        .strip_prefix('@')?
        .trim()
        .trim_matches('"')
        .trim_matches('\'');
    (!path.is_empty()).then(|| path.to_string())
}

fn artifact_identity_is_valid(artifact: &RecipeArtifactEvidence) -> bool {
    artifact.size > 0
        && is_sha256(&artifact.sha256)
        && is_absolute_evidence_path(&artifact.path)
        && normalize_evidence_path("", &artifact.path).is_some()
        && !artifact.producer_property.trim().is_empty()
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_archive_recipe_key(key: &str) -> bool {
    key == "recipe.ar.pattern" || key.starts_with("recipe.ar.pattern.")
}

fn is_combine_recipe_key(key: &str) -> bool {
    key == "recipe.c.combine.pattern" || key.starts_with("recipe.c.combine.pattern.")
}

fn is_post_link_recipe_key(key: &str) -> bool {
    key.ends_with(".pattern")
        && (key.starts_with("recipe.objcopy.")
            || (key.starts_with("recipe.hooks.")
                && (key.contains("objcopy")
                    || key.contains("postbuild")
                    || key.contains("postlink"))))
}

fn is_upload_recipe_key(key: &str) -> bool {
    key.to_ascii_lowercase().contains("upload") && key.contains(".pattern")
}

fn effective_prebuild_hook_keys(
    props: &HashMap<String, String>,
    windows_host: bool,
) -> Vec<String> {
    let mut base_keys = BTreeSet::new();
    for key in props.keys() {
        if is_base_prebuild_hook_key(key) {
            base_keys.insert(key.clone());
        } else if let Some(base) = key.strip_suffix(".windows")
            && is_base_prebuild_hook_key(base)
        {
            base_keys.insert(base.to_string());
        }
    }

    base_keys
        .into_iter()
        .filter_map(|base| {
            if windows_host {
                let windows = format!("{base}.windows");
                if props
                    .get(&windows)
                    .is_some_and(|value| !value.trim().is_empty())
                {
                    return Some(windows);
                }
            }
            props
                .get(&base)
                .is_some_and(|value| !value.trim().is_empty())
                .then_some(base)
        })
        .collect()
}

fn is_base_prebuild_hook_key(key: &str) -> bool {
    key.starts_with("recipe.hooks.prebuild.") && key.ends_with(".pattern")
}

fn property_recipe_is_replayable(
    props: &HashMap<String, String>,
    key: &str,
    allowed_placeholders: &[&str],
) -> bool {
    let Some(recipe) = props.get(key).map(String::as_str).map(str::trim) else {
        return false;
    };
    if recipe.is_empty() {
        return false;
    }
    placeholders(recipe).is_some_and(|observed| {
        observed.iter().all(|placeholder| {
            allowed_placeholders
                .iter()
                .any(|allowed| placeholder == allowed)
        })
    })
}

fn placeholders(value: &str) -> Option<Vec<String>> {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'{' => {
                let start = index + 1;
                let Some(relative_end) = value[start..].find('}') else {
                    return None;
                };
                let end = start + relative_end;
                let token = value[start..end].trim();
                if token.is_empty() || token.contains('{') {
                    return None;
                }
                out.push(token.to_string());
                index = end + 1;
            }
            b'}' => return None,
            _ => index += 1,
        }
    }
    Some(out)
}

fn contains_placeholder(value: &str) -> bool {
    value.contains('{') || value.contains('}')
}

fn property_recipe_mentions_artifact(
    props: &HashMap<String, String>,
    key: &str,
    artifact_path: &str,
) -> bool {
    let Some(recipe) = props.get(key) else {
        return false;
    };
    let Some(artifact) = normalize_evidence_path("", artifact_path) else {
        return false;
    };
    text_mentions_exact_path(
        &normalize_slashes(recipe).to_ascii_lowercase(),
        &artifact.to_ascii_lowercase(),
    )
}

fn text_mentions_exact_path(text: &str, path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    let mut offset = 0usize;
    while let Some(relative) = text[offset..].find(path) {
        let start = offset + relative;
        let end = start + path.len();
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        let boundary = |character: Option<char>| {
            character.is_none_or(|character| {
                character.is_whitespace()
                    || matches!(character, '"' | '\'' | '=' | ',' | ';' | '>' | '<')
            })
        };
        if boundary(before) && boundary(after) {
            return true;
        }
        offset = end;
    }
    false
}

fn normalized_basename(path: &str) -> String {
    normalize_slashes(path)
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_string()
}

fn normalize_slashes(value: &str) -> String {
    value.replace('\\', "/")
}

fn is_absolute_evidence_path(raw: &str) -> bool {
    let normalized = normalize_slashes(raw.trim().trim_matches('"').trim_matches('\''));
    normalized.starts_with('/')
        || (normalized.as_bytes().get(1) == Some(&b':')
            && normalized.as_bytes().get(2) == Some(&b'/'))
}

/// Lexically normalize a captured path without touching the host filesystem.
/// Parent traversal that would escape an absolute root is rejected.
fn normalize_evidence_path(base: &str, raw: &str) -> Option<String> {
    let raw = normalize_slashes(raw.trim().trim_matches('"').trim_matches('\''));
    let lower = raw.to_ascii_lowercase();
    let raw = if lower.starts_with("//?/unc/") {
        format!("//{}", &raw[8..])
    } else if lower.starts_with("//?/") {
        raw[4..].to_string()
    } else {
        raw
    };
    if raw.is_empty() || raw.contains('\0') {
        return None;
    }
    let absolute = is_absolute_evidence_path(&raw);
    let combined = if absolute || base.trim().is_empty() {
        raw
    } else {
        format!("{}/{}", normalize_slashes(base.trim()), raw)
    };
    let prefix =
        if combined.as_bytes().get(1) == Some(&b':') && combined.as_bytes().get(2) == Some(&b'/') {
            Some(combined[..2].to_ascii_lowercase())
        } else if combined.starts_with('/') {
            Some(String::new())
        } else {
            None
        };
    let body = if prefix.as_ref().is_some_and(|prefix| !prefix.is_empty()) {
        &combined[2..]
    } else {
        combined.as_str()
    };
    let mut parts = Vec::new();
    for part in body.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return None;
                }
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        return None;
    }
    let joined = parts.join("/");
    Some(match prefix {
        Some(prefix) if prefix.is_empty() => format!("/{joined}"),
        Some(prefix) => format!("{prefix}/{joined}"),
        None => joined,
    })
}

fn baseline_fingerprint(evidence: &RecipeCapabilityEvidence<'_>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ck-recipe-capability-baseline-v1\0");
    let mut props = evidence.expanded_properties.iter().collect::<Vec<_>>();
    props.sort_by(|(left, _), (right, _)| left.cmp(right));
    for (key, value) in props {
        hash_field(&mut hasher, key.as_bytes());
        hash_field(&mut hasher, value.as_bytes());
    }
    hash_field(&mut hasher, evidence.compile_commands_json.as_bytes());
    hash_field(
        &mut hasher,
        evidence
            .previous_compile_commands_json
            .unwrap_or("")
            .as_bytes(),
    );
    if let Some(artifacts) = evidence.artifacts {
        let mut artifacts = artifacts.to_vec();
        artifacts.sort_by(|left, right| left.path.cmp(&right.path));
        hash_field(
            &mut hasher,
            serde_json::to_string(&artifacts)
                .unwrap_or_default()
                .as_bytes(),
        );
    } else {
        hash_field(&mut hasher, b"<artifact-roles-missing>");
    }
    if let Some(response_files) = evidence.response_files {
        let mut response_files = response_files.to_vec();
        response_files.sort_by(|left, right| left.path.cmp(&right.path));
        hash_field(
            &mut hasher,
            serde_json::to_string(&response_files)
                .unwrap_or_default()
                .as_bytes(),
        );
    } else {
        hash_field(&mut hasher, b"<response-files-missing>");
    }
    hex::encode(hasher.finalize())
}

fn hash_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    fn props() -> HashMap<String, String> {
        HashMap::from([
            ("build.project_name".into(), "demo.ino".into()),
            (
                "recipe.ar.pattern".into(),
                "tool-ar rcs /build/{archive_file} {object_file}".into(),
            ),
            (
                "recipe.c.combine.pattern".into(),
                "tool-ld {object_files} /build/core/core.a -o /build/demo.ino.elf".into(),
            ),
            (
                "recipe.objcopy.bin.pattern".into(),
                "tool-objcopy /build/demo.ino.elf /build/demo.ino.bin".into(),
            ),
            (
                "tools.uploader.upload.pattern".into(),
                "uploader --port {serial.port} /build/demo.ino.bin".into(),
            ),
            (
                "recipe.hooks.prebuild.1.pattern".into(),
                "generator --output /build/generated.h".into(),
            ),
        ])
    }

    fn ccdb(library: Option<&str>, response: bool) -> String {
        let response_token = response.then_some("@/build/compiler.rsp");
        let mut entries = vec![serde_json::json!({
            "directory": "/build",
            "arguments": ["tool-cpp", response_token.unwrap_or("-O2"), "-c", "/build/sketch/demo.ino.cpp", "-o", "/build/sketch/demo.ino.cpp.o"],
            "file": "/build/sketch/demo.ino.cpp"
        })];
        if let Some(library) = library {
            entries.push(serde_json::json!({
                "directory": "/build",
                "arguments": ["tool-cpp", "-c", format!("/sdk/libraries/{library}/src/{library}.cpp"), "-o", format!("/build/libraries/{library}/{library}.cpp.o")],
                "file": format!("/sdk/libraries/{library}/src/{library}.cpp")
            }));
        }
        serde_json::to_string(&entries).unwrap()
    }

    fn artifacts() -> Vec<RecipeArtifactEvidence> {
        vec![
            RecipeArtifactEvidence {
                role: RecipeArtifactRole::CoreArchive,
                path: "/build/core/core.a".into(),
                size: 100,
                sha256: HASH_A.into(),
                producer_property: "recipe.ar.pattern".into(),
                consumer_properties: Vec::new(),
                upload_required: false,
            },
            RecipeArtifactEvidence {
                role: RecipeArtifactRole::LinkOutput,
                path: "/build/demo.ino.elf".into(),
                size: 200,
                sha256: HASH_B.into(),
                producer_property: "recipe.c.combine.pattern".into(),
                consumer_properties: Vec::new(),
                upload_required: false,
            },
            RecipeArtifactEvidence {
                role: RecipeArtifactRole::FirmwareImage,
                path: "/build/demo.ino.bin".into(),
                size: 150,
                sha256: HASH_C.into(),
                producer_property: "recipe.objcopy.bin.pattern".into(),
                consumer_properties: vec!["tools.uploader.upload.pattern".into()],
                upload_required: true,
            },
        ]
    }

    fn response_files() -> Vec<RecipeResponseFileEvidence> {
        let contents = "-DVALUE=1 @nested/defines.rsp".to_string();
        let nested = "-DSECOND=2".to_string();
        vec![
            RecipeResponseFileEvidence {
                path: "/build/compiler.rsp".into(),
                sha256: hex::encode(Sha256::digest(contents.as_bytes())),
                contents,
            },
            RecipeResponseFileEvidence {
                path: "/build/nested/defines.rsp".into(),
                sha256: hex::encode(Sha256::digest(nested.as_bytes())),
                contents: nested,
            },
        ]
    }

    fn role_adapter_props() -> HashMap<String, String> {
        HashMap::from([
            ("build.project_name".into(), "demo.ino".into()),
            (
                "recipe.ar.pattern".into(),
                "tool-ar -o /build/core.bundle {object_file}".into(),
            ),
            (
                "recipe.c.combine.pattern".into(),
                "tool-link {object_files} /build/core.bundle -o /build/linked.payload".into(),
            ),
            (
                "recipe.objcopy.payload.pattern".into(),
                "tool-copy /build/linked.payload --output=/build/upload.payload".into(),
            ),
            (
                "tools.transport.upload.pattern".into(),
                "transport --port {serial.port} /build/upload.payload".into(),
            ),
        ])
    }

    fn role_adapter_manifest() -> RecipeBuildArtifactManifest {
        RecipeBuildArtifactManifest {
            schema_version: RECIPE_BUILD_ARTIFACT_MANIFEST_SCHEMA_VERSION,
            primary_relative_path: "linked.payload".into(),
            artifacts: vec![
                RecipeBuildArtifactIdentity {
                    relative_path: "core.bundle".into(),
                    size: 80,
                    sha256: HASH_A.into(),
                    authenticated_producer_property: None,
                },
                RecipeBuildArtifactIdentity {
                    relative_path: "linked.payload".into(),
                    size: 100,
                    sha256: HASH_B.into(),
                    authenticated_producer_property: None,
                },
                RecipeBuildArtifactIdentity {
                    relative_path: "upload.payload".into(),
                    size: 90,
                    sha256: HASH_C.into(),
                    authenticated_producer_property: None,
                },
            ],
        }
    }

    #[test]
    fn missing_evidence_is_fail_closed() {
        let props = HashMap::new();
        let evidence = RecipeCapabilityEvidence {
            expanded_properties: &props,
            compile_commands_json: "",
            previous_compile_commands_json: None,
            artifacts: None,
            response_files: None,
        };
        let report = extract_recipe_capabilities(&evidence);
        assert_eq!(report.capabilities, RecipeCapabilityVector::default());
        assert_eq!(report.blockers.len(), 8);
        assert!(is_sha256(&report.baseline_sha256));
    }

    #[test]
    fn generic_recipe_graph_can_prove_all_observed_capabilities() {
        let props = props();
        let current = ccdb(Some("Beta"), true);
        let previous = ccdb(Some("Alpha"), false);
        let artifacts = artifacts();
        let response_files = response_files();
        let report = extract_recipe_capabilities(&RecipeCapabilityEvidence {
            expanded_properties: &props,
            compile_commands_json: &current,
            previous_compile_commands_json: Some(&previous),
            artifacts: Some(&artifacts),
            response_files: Some(&response_files),
        });
        assert_eq!(
            report.capabilities,
            RecipeCapabilityVector {
                sketch_compile: true,
                library_graph_transition: true,
                core_archive_reuse: true,
                direct_link: true,
                post_link_artifacts: true,
                upload_ready: true,
                response_files: true,
                prebuild_hooks: true,
            }
        );
        assert!(report.blockers.is_empty(), "{:?}", report.blockers);
    }

    #[test]
    fn artifact_roles_come_from_unique_recipe_paths_not_extensions() {
        let props = role_adapter_props();
        let ccdb = ccdb(None, false);
        let adaptation = adapt_artifact_roles_from_baseline(
            &props,
            &ccdb,
            Path::new("/build"),
            &role_adapter_manifest(),
        );
        assert!(adaptation.complete, "{:?}", adaptation.blockers);
        assert_eq!(adaptation.artifacts.len(), 3);
        let roles = adaptation
            .artifacts
            .iter()
            .map(|artifact| (artifact.path.as_str(), artifact.role.clone()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(roles["/build/core.bundle"], RecipeArtifactRole::CoreArchive);
        assert_eq!(
            roles["/build/linked.payload"],
            RecipeArtifactRole::LinkOutput
        );
        assert_eq!(
            roles["/build/upload.payload"],
            RecipeArtifactRole::FirmwareImage
        );
        let upload = adaptation
            .artifacts
            .iter()
            .find(|artifact| artifact.path == "/build/upload.payload")
            .unwrap();
        assert!(upload.upload_required);
        assert_eq!(
            upload.consumer_properties,
            ["tools.transport.upload.pattern"]
        );

        let report = extract_recipe_capabilities(&RecipeCapabilityEvidence {
            expanded_properties: &props,
            compile_commands_json: &ccdb,
            previous_compile_commands_json: None,
            artifacts: adaptation.complete_evidence(),
            response_files: None,
        });
        assert!(report.capabilities.core_archive_reuse);
        assert!(report.capabilities.direct_link);
        assert!(report.capabilities.post_link_artifacts);
        assert!(report.capabilities.upload_ready);
    }

    #[test]
    fn prebuild_and_merge_outputs_keep_esp32_style_artifacts_unambiguous() {
        let mut props = role_adapter_props();
        // Both variants exist in an expanded ESP32 property map. The adapter
        // must select only the host-effective one and bind its bootloader
        // output without treating the later merge command inputs as producers.
        props.insert(
            "recipe.hooks.prebuild.4.pattern".into(),
            "prebuild-tool -o /build/bootloader.payload".into(),
        );
        props.insert(
            "recipe.hooks.prebuild.4.pattern.windows".into(),
            "prebuild-tool -o /build/bootloader.payload".into(),
        );
        props.insert(
            "recipe.hooks.objcopy.postobjcopy.3.pattern".into(),
            "merge-tool -o /build/merged.payload /build/bootloader.payload /build/upload.payload"
                .into(),
        );
        let mut manifest = role_adapter_manifest();
        manifest.artifacts.push(RecipeBuildArtifactIdentity {
            relative_path: "bootloader.payload".into(),
            size: 70,
            sha256: HASH_A.into(),
            authenticated_producer_property: None,
        });
        manifest.artifacts.push(RecipeBuildArtifactIdentity {
            relative_path: "merged.payload".into(),
            size: 120,
            sha256: HASH_B.into(),
            authenticated_producer_property: None,
        });

        let adaptation = adapt_artifact_roles_from_baseline(
            &props,
            &ccdb(None, false),
            Path::new("/build"),
            &manifest,
        );
        assert!(adaptation.complete, "{:?}", adaptation.blockers);
        let roles = adaptation
            .artifacts
            .iter()
            .map(|artifact| (artifact.path.as_str(), artifact.role.clone()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            roles["/build/bootloader.payload"],
            RecipeArtifactRole::PrebuildAuxiliary
        );
        assert_eq!(
            roles["/build/merged.payload"],
            RecipeArtifactRole::PostLinkAuxiliary
        );
    }

    #[test]
    fn post_link_recipe_keys_exclude_pattern_args_but_keep_postobjcopy_hooks() {
        assert!(is_post_link_recipe_key("recipe.objcopy.bin.pattern"));
        assert!(is_post_link_recipe_key(
            "recipe.hooks.objcopy.postobjcopy.3.pattern"
        ));
        assert!(!is_post_link_recipe_key("recipe.objcopy.bin.pattern_args"));
        assert!(!is_post_link_recipe_key(
            "recipe.hooks.objcopy.postobjcopy.3.pattern_args"
        ));
    }

    #[test]
    fn esp32_bin_and_merged_manifest_uses_unique_executable_recipe_producers() {
        let props = HashMap::from([
            ("build.project_name".into(), "demo.ino".into()),
            (
                "recipe.ar.pattern".into(),
                "tool-ar -o /build/core/core.a /build/core/member.o".into(),
            ),
            (
                "recipe.c.combine.pattern".into(),
                "tool-link {object_files} /build/core/core.a -o /build/demo.ino.elf".into(),
            ),
            (
                "recipe.hooks.prebuild.4.pattern".into(),
                "esptool elf2image -o /build/demo.ino.bootloader.bin".into(),
            ),
            (
                "recipe.objcopy.partitions.bin.pattern".into(),
                "gen-partitions -o /build/demo.ino.partitions.bin".into(),
            ),
            // Arduino Core metadata, not an executable recipe. It deliberately
            // repeats the output so accepting `pattern_args` would make the
            // producer ambiguous.
            (
                "recipe.objcopy.partitions.bin.pattern_args".into(),
                "metadata --output=/build/demo.ino.partitions.bin".into(),
            ),
            (
                "recipe.objcopy.bin.pattern".into(),
                "esptool elf2image -o /build/demo.ino.bin /build/demo.ino.elf".into(),
            ),
            (
                "recipe.objcopy.bin.pattern_args".into(),
                "metadata --output=/build/demo.ino.bin".into(),
            ),
            (
                "recipe.hooks.objcopy.postobjcopy.3.pattern".into(),
                "esptool merge_bin -o /build/demo.ino.merged.bin /build/demo.ino.bootloader.bin /build/demo.ino.partitions.bin /build/demo.ino.bin".into(),
            ),
        ]);
        let manifest = RecipeBuildArtifactManifest {
            schema_version: RECIPE_BUILD_ARTIFACT_MANIFEST_SCHEMA_VERSION,
            primary_relative_path: "demo.ino.elf".into(),
            artifacts: vec![
                RecipeBuildArtifactIdentity {
                    relative_path: "core/core.a".into(),
                    size: 80,
                    sha256: HASH_A.into(),
                    authenticated_producer_property: None,
                },
                RecipeBuildArtifactIdentity {
                    relative_path: "demo.ino.elf".into(),
                    size: 100,
                    sha256: HASH_B.into(),
                    authenticated_producer_property: None,
                },
                RecipeBuildArtifactIdentity {
                    relative_path: "demo.ino.bootloader.bin".into(),
                    size: 70,
                    sha256: HASH_C.into(),
                    authenticated_producer_property: None,
                },
                RecipeBuildArtifactIdentity {
                    relative_path: "demo.ino.partitions.bin".into(),
                    size: 60,
                    sha256: HASH_A.into(),
                    authenticated_producer_property: None,
                },
                RecipeBuildArtifactIdentity {
                    relative_path: "demo.ino.bin".into(),
                    size: 120,
                    sha256: HASH_B.into(),
                    authenticated_producer_property: None,
                },
                RecipeBuildArtifactIdentity {
                    relative_path: "demo.ino.merged.bin".into(),
                    size: 160,
                    sha256: HASH_C.into(),
                    authenticated_producer_property: None,
                },
            ],
        };

        let adaptation = adapt_artifact_roles_from_baseline(
            &props,
            &ccdb(None, false),
            Path::new("/build"),
            &manifest,
        );
        assert!(adaptation.complete, "{:?}", adaptation.blockers);
        let producers = adaptation
            .artifacts
            .iter()
            .map(|artifact| (artifact.path.as_str(), artifact.producer_property.as_str()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            producers["/build/demo.ino.bootloader.bin"],
            "recipe.hooks.prebuild.4.pattern"
        );
        assert_eq!(
            producers["/build/demo.ino.partitions.bin"],
            "recipe.objcopy.partitions.bin.pattern"
        );
        assert_eq!(
            producers["/build/demo.ino.bin"],
            "recipe.objcopy.bin.pattern"
        );
        assert_eq!(
            producers["/build/demo.ino.merged.bin"],
            "recipe.hooks.objcopy.postobjcopy.3.pattern"
        );
    }

    #[test]
    fn candidate_assessment_uses_one_architecture_neutral_requirement_set() {
        let mut report = RecipeCapabilityReport {
            schema_version: RECIPE_CAPABILITY_SCHEMA_VERSION,
            baseline_sha256: HASH_A.into(),
            capabilities: RecipeCapabilityVector {
                sketch_compile: true,
                library_graph_transition: false,
                core_archive_reuse: true,
                direct_link: true,
                post_link_artifacts: true,
                upload_ready: true,
                response_files: false,
                prebuild_hooks: false,
            },
            observed_response_files: false,
            observed_prebuild_hooks: false,
            blockers: BTreeMap::new(),
        };
        let compile = assess_recipe_capability_candidate(
            &report,
            true,
            RecipeCapabilityCandidateIntent::Compile,
        );
        assert!(compile.capability_gate_passed);
        assert!(compile.observation_only);
        assert!(
            !compile.required_capabilities.iter().any(|name| {
                name.contains("esp") || name.contains("stm") || name.contains("avr")
            })
        );

        let upload = assess_recipe_capability_candidate(
            &report,
            true,
            RecipeCapabilityCandidateIntent::UploadReady,
        );
        assert!(upload.capability_gate_passed);
        assert!(
            upload
                .required_capabilities
                .contains(&CAP_UPLOAD_READY.to_string())
        );

        report.capabilities.upload_ready = false;
        let blocked = assess_recipe_capability_candidate(
            &report,
            true,
            RecipeCapabilityCandidateIntent::UploadReady,
        );
        assert!(!blocked.capability_gate_passed);
        assert_eq!(blocked.missing_capabilities, [CAP_UPLOAD_READY]);
    }

    #[test]
    fn native_recipe_cache_observation_requires_real_sketch_artifacts_and_response_proof() {
        let report = RecipeCapabilityReport {
            schema_version: RECIPE_CAPABILITY_SCHEMA_VERSION,
            baseline_sha256: HASH_A.into(),
            capabilities: RecipeCapabilityVector {
                sketch_compile: true,
                response_files: true,
                // These capabilities remain unavailable on purpose: a
                // PortableFast observation must not inherit DirectLink's
                // Core/archive replay prerequisites.
                core_archive_reuse: false,
                direct_link: false,
                prebuild_hooks: false,
                ..RecipeCapabilityVector::default()
            },
            observed_response_files: true,
            observed_prebuild_hooks: true,
            blockers: BTreeMap::new(),
        };
        let assessment = assess_recipe_capability_candidate(
            &report,
            true,
            RecipeCapabilityCandidateIntent::NativeRecipeCache,
        );
        assert!(assessment.capability_gate_passed, "{assessment:?}");
        assert_eq!(
            assessment.required_capabilities,
            [
                CAP_SKETCH_COMPILE.to_string(),
                "artifact_roles_complete".to_string(),
                CAP_RESPONSE_FILES.to_string(),
            ]
        );
        assert!(!assessment.required_capabilities.iter().any(|capability| {
            capability == CAP_CORE_ARCHIVE_REUSE
                || capability == CAP_DIRECT_LINK
                || capability == CAP_PREBUILD_HOOKS
        }));

        let mut missing_sketch = report.clone();
        missing_sketch.capabilities.sketch_compile = false;
        let missing_sketch = assess_recipe_capability_candidate(
            &missing_sketch,
            true,
            RecipeCapabilityCandidateIntent::NativeRecipeCache,
        );
        assert_eq!(missing_sketch.missing_capabilities, [CAP_SKETCH_COMPILE]);

        let incomplete_artifacts = assess_recipe_capability_candidate(
            &report,
            false,
            RecipeCapabilityCandidateIntent::NativeRecipeCache,
        );
        assert_eq!(
            incomplete_artifacts.missing_capabilities,
            ["artifact_roles_complete"]
        );

        let mut missing_response = report;
        missing_response.capabilities.response_files = false;
        let missing_response = assess_recipe_capability_candidate(
            &missing_response,
            true,
            RecipeCapabilityCandidateIntent::NativeRecipeCache,
        );
        assert_eq!(missing_response.missing_capabilities, [CAP_RESPONSE_FILES]);
    }

    #[test]
    fn observed_response_files_and_hooks_add_fail_closed_requirements() {
        let report = RecipeCapabilityReport {
            schema_version: RECIPE_CAPABILITY_SCHEMA_VERSION,
            baseline_sha256: HASH_A.into(),
            capabilities: RecipeCapabilityVector {
                sketch_compile: true,
                core_archive_reuse: true,
                direct_link: true,
                ..RecipeCapabilityVector::default()
            },
            observed_response_files: true,
            observed_prebuild_hooks: true,
            blockers: BTreeMap::new(),
        };
        let assessment = assess_recipe_capability_candidate(
            &report,
            true,
            RecipeCapabilityCandidateIntent::Compile,
        );
        assert!(!assessment.capability_gate_passed);
        assert_eq!(
            assessment.missing_capabilities,
            [CAP_RESPONSE_FILES, CAP_PREBUILD_HOOKS]
        );
        assert_eq!(assessment.blockers.len(), 2);
        assert!(assessment.blockers.contains_key(CAP_RESPONSE_FILES));
        assert!(assessment.blockers.contains_key(CAP_PREBUILD_HOOKS));
    }

    #[test]
    fn replayable_prebuild_hooks_satisfy_the_candidate_requirement() {
        let report = RecipeCapabilityReport {
            schema_version: RECIPE_CAPABILITY_SCHEMA_VERSION,
            baseline_sha256: HASH_A.into(),
            capabilities: RecipeCapabilityVector {
                sketch_compile: true,
                core_archive_reuse: true,
                direct_link: true,
                prebuild_hooks: true,
                ..RecipeCapabilityVector::default()
            },
            observed_response_files: false,
            observed_prebuild_hooks: true,
            blockers: BTreeMap::new(),
        };
        let assessment = assess_recipe_capability_candidate(
            &report,
            true,
            RecipeCapabilityCandidateIntent::Compile,
        );
        assert!(assessment.capability_gate_passed);
        assert!(
            assessment
                .required_capabilities
                .contains(&CAP_PREBUILD_HOOKS.to_string())
        );
        assert!(assessment.missing_capabilities.is_empty());
        assert!(assessment.blockers.is_empty());
    }

    #[test]
    fn candidate_blockers_preserve_report_reasons_and_legacy_schema_reads() {
        let report_reason = "captured response file changed".to_string();
        let report = RecipeCapabilityReport {
            schema_version: RECIPE_CAPABILITY_SCHEMA_VERSION,
            baseline_sha256: HASH_A.into(),
            capabilities: RecipeCapabilityVector {
                sketch_compile: true,
                core_archive_reuse: true,
                direct_link: true,
                ..RecipeCapabilityVector::default()
            },
            observed_response_files: true,
            observed_prebuild_hooks: false,
            blockers: BTreeMap::from([(
                CAP_RESPONSE_FILES.to_string(),
                vec![report_reason.clone()],
            )]),
        };
        let assessment = assess_recipe_capability_candidate(
            &report,
            false,
            RecipeCapabilityCandidateIntent::Compile,
        );
        assert_eq!(assessment.blockers[CAP_RESPONSE_FILES], [report_reason]);
        assert_eq!(
            assessment.blockers["artifact_roles_complete"],
            ["artifact role adaptation is incomplete"]
        );

        let mut legacy_value = serde_json::to_value(&assessment).unwrap();
        legacy_value.as_object_mut().unwrap().remove("blockers");
        let legacy: RecipeCapabilityCandidateAssessment =
            serde_json::from_value(legacy_value).unwrap();
        assert_eq!(legacy.schema_version, RECIPE_CAPABILITY_SCHEMA_VERSION);
        assert!(legacy.blockers.is_empty());
    }

    #[test]
    fn artifact_role_adapter_rejects_multiple_possible_producers() {
        let mut props = role_adapter_props();
        props.insert(
            "recipe.objcopy.alternate.pattern".into(),
            "other-copy /build/linked.payload /build/upload.payload".into(),
        );
        let adaptation = adapt_artifact_roles_from_baseline(
            &props,
            &ccdb(None, false),
            Path::new("/build"),
            &role_adapter_manifest(),
        );
        assert!(!adaptation.complete);
        assert!(
            adaptation
                .blockers
                .iter()
                .any(|blocker| blocker.contains("possible post-link producers"))
        );
        assert!(adaptation.complete_evidence().is_none());
    }

    #[test]
    fn authenticated_archive_producer_binds_dynamic_arduino_archive_placeholder() {
        let mut props = role_adapter_props();
        props.insert(
            "recipe.ar.pattern".into(),
            "tool-ar {archive_file_path} {object_file}".into(),
        );
        props.insert(
            "recipe.c.combine.pattern".into(),
            "tool-link {object_files} {archive_file_path} -o /build/linked.payload".into(),
        );
        let mut manifest = role_adapter_manifest();
        manifest.artifacts[0].authenticated_producer_property = Some("recipe.ar.pattern".into());
        let adaptation = adapt_artifact_roles_from_baseline(
            &props,
            &ccdb(None, false),
            Path::new("/build"),
            &manifest,
        );
        assert!(adaptation.complete, "{:?}", adaptation.blockers);
        assert!(adaptation.artifacts.iter().any(|artifact| {
            artifact.role == RecipeArtifactRole::CoreArchive
                && artifact.path == "/build/core.bundle"
                && artifact.producer_property == "recipe.ar.pattern"
        }));
    }

    #[test]
    fn artifact_role_adapter_requires_exact_recipe_path_boundaries() {
        let mut props = role_adapter_props();
        props.insert(
            "recipe.objcopy.payload.pattern".into(),
            "tool-copy /build/linked.payload /build/upload.payload.extra".into(),
        );
        let adaptation = adapt_artifact_roles_from_baseline(
            &props,
            &ccdb(None, false),
            Path::new("/build"),
            &role_adapter_manifest(),
        );
        assert!(!adaptation.complete);
        assert!(
            adaptation
                .blockers
                .iter()
                .any(|blocker| blocker.contains("upload.payload"))
        );
    }

    #[test]
    fn artifact_role_adapter_rejects_ccdb_outputs_as_final_artifacts() {
        let props = role_adapter_props();
        let mut manifest = role_adapter_manifest();
        manifest.artifacts.push(RecipeBuildArtifactIdentity {
            relative_path: "sketch/demo.ino.cpp.o".into(),
            size: 20,
            sha256: HASH_A.into(),
            authenticated_producer_property: None,
        });
        let adaptation = adapt_artifact_roles_from_baseline(
            &props,
            &ccdb(None, false),
            Path::new("/build"),
            &manifest,
        );
        assert!(!adaptation.complete);
        assert!(
            adaptation
                .blockers
                .iter()
                .any(|blocker| blocker.contains("CCDB compile output"))
        );
    }

    #[test]
    fn internal_build_manifest_projection_is_lossless() {
        let internal = super::super::BuildArtifactManifest {
            schema_version: RECIPE_BUILD_ARTIFACT_MANIFEST_SCHEMA_VERSION,
            primary_relative_path: "linked.payload".into(),
            artifacts: vec![super::super::BuildArtifactIdentity {
                relative_path: "linked.payload".into(),
                size: 42,
                sha256: HASH_A.into(),
            }],
        };
        let projected = RecipeBuildArtifactManifest::from(&internal);
        assert_eq!(projected.schema_version, internal.schema_version);
        assert_eq!(
            projected.primary_relative_path,
            internal.primary_relative_path
        );
        assert_eq!(projected.artifacts[0].relative_path, "linked.payload");
        assert_eq!(projected.artifacts[0].size, 42);
        assert_eq!(projected.artifacts[0].sha256, HASH_A);
    }

    #[test]
    fn one_ccdb_never_claims_a_library_transition() {
        let props = props();
        let current = ccdb(Some("Beta"), false);
        let artifacts = artifacts();
        let report = extract_recipe_capabilities(&RecipeCapabilityEvidence {
            expanded_properties: &props,
            compile_commands_json: &current,
            previous_compile_commands_json: None,
            artifacts: Some(&artifacts),
            response_files: None,
        });
        assert!(report.capabilities.sketch_compile);
        assert!(!report.capabilities.library_graph_transition);
        assert!(
            report.blockers[CAP_LIBRARY_GRAPH_TRANSITION]
                .iter()
                .any(|reason| reason.contains("previous"))
        );
    }

    #[test]
    fn identical_library_graphs_are_not_a_transition() {
        let props = props();
        let current = ccdb(Some("Alpha"), false);
        let previous = ccdb(Some("Alpha"), false);
        let artifacts = artifacts();
        let report = extract_recipe_capabilities(&RecipeCapabilityEvidence {
            expanded_properties: &props,
            compile_commands_json: &current,
            previous_compile_commands_json: Some(&previous),
            artifacts: Some(&artifacts),
            response_files: None,
        });
        assert!(!report.capabilities.library_graph_transition);
    }

    #[test]
    fn missing_artifact_manifest_does_not_block_sketch_observation() {
        let props = props();
        let current = ccdb(None, false);
        let report = extract_recipe_capabilities(&RecipeCapabilityEvidence {
            expanded_properties: &props,
            compile_commands_json: &current,
            previous_compile_commands_json: None,
            artifacts: None,
            response_files: None,
        });
        assert!(report.capabilities.sketch_compile);
        assert!(!report.capabilities.core_archive_reuse);
        assert!(!report.capabilities.direct_link);
        assert!(!report.capabilities.post_link_artifacts);
        assert!(!report.capabilities.upload_ready);
    }

    #[test]
    fn response_file_hash_and_nested_content_are_required() {
        let props = props();
        let current = ccdb(None, true);
        let artifacts = artifacts();
        let mut files = response_files();
        files[1].sha256 = HASH_A.into();
        let report = extract_recipe_capabilities(&RecipeCapabilityEvidence {
            expanded_properties: &props,
            compile_commands_json: &current,
            previous_compile_commands_json: None,
            artifacts: Some(&artifacts),
            response_files: Some(&files),
        });
        assert!(!report.capabilities.response_files);
        assert!(
            report.blockers[CAP_RESPONSE_FILES]
                .iter()
                .any(|reason| reason.contains("hash") || reason.contains("changed"))
        );
    }

    #[test]
    fn empty_response_file_is_valid_but_command_lines_remain_strict() {
        let props = props();
        let current = ccdb(None, true);
        let empty = String::new();
        let response_files = vec![RecipeResponseFileEvidence {
            path: "/build/compiler.rsp".into(),
            sha256: hex::encode(Sha256::digest(empty.as_bytes())),
            contents: empty,
        }];
        let report = extract_recipe_capabilities(&RecipeCapabilityEvidence {
            expanded_properties: &props,
            compile_commands_json: &current,
            previous_compile_commands_json: None,
            artifacts: None,
            response_files: Some(&response_files),
        });
        assert!(report.capabilities.response_files, "{:?}", report.blockers);
        assert_eq!(
            split_response_file_contents("   ").unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            split_command_line(""),
            Err("command line has no tokens".to_string())
        );
        assert_eq!(
            split_response_file_contents(r#"-DVERSION=\"1.2.3\" -DNAME=value"#).unwrap(),
            ["-DVERSION=\"1.2.3\"", "-DNAME=value"]
        );
        assert!(split_response_file_contents("\"").is_err());
    }

    #[test]
    fn prebuild_hooks_select_only_the_host_effective_pattern() {
        let base_key = "recipe.hooks.prebuild.1.pattern";
        let windows_key = "recipe.hooks.prebuild.1.pattern.windows";
        let mut props = HashMap::from([
            (
                base_key.to_string(),
                "base-generator --emit output".to_string(),
            ),
            (
                windows_key.to_string(),
                "host-generator {unresolved.output}".to_string(),
            ),
        ]);

        let non_windows = effective_prebuild_hook_keys(&props, false);
        assert_eq!(non_windows, [base_key]);
        assert!(decide_prebuild_hooks(&props, &non_windows).available);

        let windows = effective_prebuild_hook_keys(&props, true);
        assert_eq!(windows, [windows_key]);
        assert!(!decide_prebuild_hooks(&props, &windows).available);

        props.insert(windows_key.to_string(), "  ".to_string());
        let windows_fallback = effective_prebuild_hook_keys(&props, true);
        assert_eq!(windows_fallback, [base_key]);
        assert!(decide_prebuild_hooks(&props, &windows_fallback).available);
    }

    #[test]
    fn unresolved_hook_and_upload_placeholders_remain_closed() {
        let mut props = props();
        props.insert(
            "recipe.hooks.prebuild.1.pattern".into(),
            "generator {unknown.output}".into(),
        );
        props.insert(
            "tools.uploader.upload.pattern".into(),
            "uploader {unknown.option} /build/demo.ino.bin".into(),
        );
        let current = ccdb(None, false);
        let artifacts = artifacts();
        let report = extract_recipe_capabilities(&RecipeCapabilityEvidence {
            expanded_properties: &props,
            compile_commands_json: &current,
            previous_compile_commands_json: None,
            artifacts: Some(&artifacts),
            response_files: None,
        });
        assert!(!report.capabilities.prebuild_hooks);
        assert!(!report.capabilities.upload_ready);
        assert!(report.capabilities.post_link_artifacts);
    }

    #[test]
    fn malformed_artifact_identity_blocks_dependent_capabilities() {
        let props = props();
        let current = ccdb(None, false);
        let mut artifacts = artifacts();
        artifacts[0].sha256 = "not-a-hash".into();
        let report = extract_recipe_capabilities(&RecipeCapabilityEvidence {
            expanded_properties: &props,
            compile_commands_json: &current,
            previous_compile_commands_json: None,
            artifacts: Some(&artifacts),
            response_files: None,
        });
        assert!(!report.capabilities.core_archive_reuse);
        assert!(!report.capabilities.direct_link);
        assert!(!report.capabilities.post_link_artifacts);
        assert!(!report.capabilities.upload_ready);
    }

    #[test]
    fn windows_response_paths_keep_ordinary_backslashes() {
        let props = props();
        let current = serde_json::to_string(&vec![serde_json::json!({
            "directory": "C:\\Build",
            "command": "tool-cpp \"@C:\\Build\\Compiler.rsp\" -c C:\\Build\\sketch\\demo.ino.cpp -o C:\\Build\\sketch\\demo.ino.cpp.o",
            "file": "C:\\Build\\sketch\\demo.ino.cpp"
        })])
        .unwrap();
        let root_contents = "-DVALUE=1 \"@nested\\defines.rsp\"".to_string();
        let nested_contents = "-DSECOND=2".to_string();
        let response_files = vec![
            RecipeResponseFileEvidence {
                path: "\\\\?\\c:\\build\\compiler.rsp".into(),
                sha256: hex::encode(Sha256::digest(root_contents.as_bytes())),
                contents: root_contents,
            },
            RecipeResponseFileEvidence {
                path: "\\\\?\\c:\\build\\nested\\defines.rsp".into(),
                sha256: hex::encode(Sha256::digest(nested_contents.as_bytes())),
                contents: nested_contents,
            },
        ];
        let report = extract_recipe_capabilities(&RecipeCapabilityEvidence {
            expanded_properties: &props,
            compile_commands_json: &current,
            previous_compile_commands_json: None,
            artifacts: None,
            response_files: Some(&response_files),
        });
        assert!(report.capabilities.response_files, "{:?}", report.blockers);
    }
}
