use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const SCHEMA_VERSION: u32 = 1;
const FORMAT: &str = "ck-project-package";
const KIND: &str = "project-submission";
const MANIFEST_PATH: &str = "ck-project-package.json";
const MARKER_PATH: &str = "META-INF/CKPROJECT";
const MARKER_CONTENT: &[u8] = b"CKPROJECT-PACKAGE\n1\n";
const REPORT_JSON_PATH: &str = "report/project-acceptance.json";
const REPORT_HTML_PATH: &str = "report/project-acceptance.html";
const WORKSPACE_PATH: &str = "project/workspace.json";
const GENERATED_SOURCE_PATH: &str = "source/generated.ino";
const LOCK_PATH: &str = "environment/ck.lock";
const BUILD_EVIDENCE_PATH: &str = "evidence/build-summary.json";
const MAX_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_REPORT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_HTML_BYTES: u64 = 4 * 1024 * 1024;
const MAX_WORKSPACE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LOCK_BYTES: u64 = 2 * 1024 * 1024;
const MAX_BUILD_EVIDENCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectSourceScope {
    NoSource,
    EditableProject,
    GeneratedSource,
    EditableAndGenerated,
}

impl ProjectSourceScope {
    fn includes_workspace(self) -> bool {
        matches!(self, Self::EditableProject | Self::EditableAndGenerated)
    }

    fn includes_generated_source(self) -> bool {
        matches!(self, Self::GeneratedSource | Self::EditableAndGenerated)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSubmissionExportRequest {
    pub output_path: String,
    pub source_scope: ProjectSourceScope,
    pub source_disclosure_acknowledged: bool,
    pub report: Value,
    #[serde(default)]
    pub workspace_json: Option<String>,
    #[serde(default)]
    pub generated_source: Option<String>,
    #[serde(default)]
    pub ck_lock: Option<String>,
    #[serde(default)]
    pub include_build_evidence: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedBy {
    pub product: String,
    pub version: String,
    pub component: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProjectSubmissionFileRole {
    AcceptanceReport,
    PrintableReport,
    EditableProject,
    GeneratedSource,
    DependencyLock,
    BuildEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectSubmissionFileRecord {
    path: String,
    role: ProjectSubmissionFileRole,
    size: u64,
    sha256: String,
    redacted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSubmissionSummary {
    pub project_name: String,
    pub block_count: u64,
    pub workspace_sha256: String,
    pub generated_code_sha256: String,
    pub board_name: String,
    pub board_id: String,
    pub board_package_id: String,
    pub fqbn: String,
    pub core_id: String,
    pub core_version: Option<String>,
    pub compile_state: String,
    pub compile_recorded_at: Option<String>,
    pub flash_used_bytes: Option<u64>,
    pub flash_total_bytes: Option<u64>,
    pub ram_used_bytes: Option<u64>,
    pub ram_total_bytes: Option<u64>,
    pub dependency_lock_available: bool,
    pub dependency_lock_sha256: Option<String>,
    pub dependency_count: u64,
    pub dependencies_all_versioned: bool,
    pub hardware_state: String,
    pub hardware_chip: Option<String>,
    pub hardware_flash_bytes: Option<u64>,
    pub hardware_psram_bytes: Option<u64>,
    pub checkpoint_count: u64,
    pub health_summary: String,
    pub health_pass_count: u64,
    pub health_warning_count: u64,
    pub health_error_count: u64,
    pub health_info_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectSubmissionManifest {
    schema_version: u32,
    format: String,
    kind: String,
    generated_by: GeneratedBy,
    generated_at: String,
    source_scope: ProjectSourceScope,
    source_disclosure_acknowledged: bool,
    network_used: bool,
    upload_performed: bool,
    summary: ProjectSubmissionSummary,
    files: Vec<ProjectSubmissionFileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSubmissionExportResult {
    pub output_path: String,
    pub package_file_name: String,
    pub package_sha256: String,
    pub schema_version: u32,
    pub included_files: usize,
    pub source_scope: ProjectSourceScope,
    pub has_dependency_lock: bool,
    pub has_build_evidence: bool,
    pub summary: ProjectSubmissionSummary,
    pub integrity_verified: bool,
    pub publisher_identity_verified: bool,
    pub authenticity_message: String,
    pub network_used: bool,
    pub upload_performed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSubmissionInspection {
    pub valid: bool,
    pub schema_version: u32,
    pub format: String,
    pub kind: String,
    pub generated_by: GeneratedBy,
    pub generated_at: String,
    pub package_file_name: String,
    pub package_sha256: String,
    pub included_files: usize,
    pub source_scope: ProjectSourceScope,
    pub source_disclosure_acknowledged: bool,
    pub has_dependency_lock: bool,
    pub has_build_evidence: bool,
    pub summary: ProjectSubmissionSummary,
    pub integrity_verified: bool,
    pub publisher_identity_verified: bool,
    pub authenticity_message: String,
    pub network_used: bool,
    pub upload_performed: bool,
}

#[derive(Debug, Clone)]
struct PreparedFile {
    path: &'static str,
    role: ProjectSubmissionFileRole,
    bytes: Vec<u8>,
    redacted: bool,
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn open_readonly_without_reparse(path: &Path) -> Result<File, String> {
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    };
    #[cfg(not(windows))]
    let file = File::open(path);
    file.map_err(|error| format!("无法打开项目提交包：{error}"))
}

fn read_regular_file_snapshot(path: &Path, expected_len: u64) -> Result<Vec<u8>, String> {
    let file = open_readonly_without_reparse(path)?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法复核项目提交包句柄：{error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() != expected_len
        || metadata.len() > MAX_ARCHIVE_BYTES
    {
        return Err("项目提交包在打开期间发生变化或不再是普通文件".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("项目提交包打开句柄不能是 Windows 重解析点".to_string());
        }
    }
    let mut bytes = Vec::with_capacity(expected_len as usize);
    file.take(MAX_ARCHIVE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取项目提交包快照：{error}"))?;
    if bytes.len() as u64 != expected_len || bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err("项目提交包在读取期间发生变化或超过大小上限".to_string());
    }
    Ok(bytes)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn object<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("项目提交包字段 {field} 必须是对象"))
}

fn exact_fields(
    value: &Map<String, Value>,
    field: &str,
    required: &[&str],
    optional: &[&str],
) -> Result<(), String> {
    let allowed = required
        .iter()
        .chain(optional.iter())
        .copied()
        .collect::<BTreeSet<_>>();
    if let Some(unknown) = value.keys().find(|key| !allowed.contains(key.as_str())) {
        return Err(format!(
            "项目验收报告字段 {field}.{unknown} 未在固定 schema 中声明"
        ));
    }
    if let Some(missing) = required.iter().find(|key| !value.contains_key(**key)) {
        return Err(format!("项目验收报告缺少字段 {field}.{missing}"));
    }
    Ok(())
}

fn required_string(value: &Value, field: &str) -> Result<String, String> {
    let output = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("项目提交包缺少有效字段 {field}"))?;
    if output.chars().count() > 16_384 {
        return Err(format!("项目提交包字段 {field} 超过长度上限"));
    }
    Ok(output.to_string())
}

fn optional_string(value: Option<&Value>, field: &str) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => required_string(value, field).map(Some),
    }
}

fn required_u64(value: &Value, field: &str) -> Result<u64, String> {
    value
        .as_u64()
        .ok_or_else(|| format!("项目提交包字段 {field} 必须是非负整数"))
}

fn optional_u64(value: Option<&Value>, field: &str) -> Result<Option<u64>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => required_u64(value, field).map(Some),
    }
}

fn required_bool(value: &Value, field: &str) -> Result<bool, String> {
    value
        .as_bool()
        .ok_or_else(|| format!("项目提交包字段 {field} 必须是布尔值"))
}

fn valid_rfc3339(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

fn count_health_state(counts: &Map<String, Value>, state: &str) -> Result<u64, String> {
    required_u64(
        counts
            .get(state)
            .ok_or_else(|| format!("项目验收报告缺少 health.counts.{state}"))?,
        &format!("health.counts.{state}"),
    )
}

fn summary_from_report(report: &Value) -> Result<ProjectSubmissionSummary, String> {
    let root = object(report, "report")?;
    exact_fields(
        root,
        "report",
        &[
            "schemaVersion",
            "kind",
            "generatedAt",
            "project",
            "target",
            "build",
            "dependencies",
            "hardware",
            "history",
            "notes",
            "health",
            "limitations",
        ],
        &[],
    )?;
    if root.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("不支持的项目验收报告 schemaVersion".to_string());
    }
    if root.get("kind").and_then(Value::as_str) != Some("ck-project-acceptance-report") {
        return Err("项目验收报告 kind 无效".to_string());
    }
    let report_generated_at = required_string(
        root.get("generatedAt")
            .ok_or("项目验收报告缺少 generatedAt")?,
        "generatedAt",
    )?;
    if !valid_rfc3339(&report_generated_at) {
        return Err("项目验收报告 generatedAt 不是有效 RFC3339 时间".to_string());
    }
    let project = object(
        root.get("project").ok_or("项目验收报告缺少 project")?,
        "project",
    )?;
    exact_fields(
        project,
        "project",
        &[
            "name",
            "blockCount",
            "workspaceSha256",
            "generatedCodeSha256",
            "structure",
            "pathIncluded",
        ],
        &[],
    )?;
    if required_bool(
        project
            .get("pathIncluded")
            .ok_or("项目验收报告缺少 project.pathIncluded")?,
        "project.pathIncluded",
    )? {
        return Err("项目验收报告不得包含本机工程路径".to_string());
    }
    let target = object(
        root.get("target").ok_or("项目验收报告缺少 target")?,
        "target",
    )?;
    exact_fields(
        target,
        "target",
        &[
            "boardName",
            "boardId",
            "boardPackageId",
            "fqbn",
            "coreId",
            "coreVersion",
        ],
        &[],
    )?;
    let build = object(root.get("build").ok_or("项目验收报告缺少 build")?, "build")?;
    exact_fields(
        build,
        "build",
        &[
            "state",
            "recordedAt",
            "profile",
            "durationMs",
            "warningCount",
            "flashUsedBytes",
            "flashTotalBytes",
            "ramUsedBytes",
            "ramTotalBytes",
            "resourceGrowth",
        ],
        &[],
    )?;
    let dependencies = object(
        root.get("dependencies")
            .ok_or("项目验收报告缺少 dependencies")?,
        "dependencies",
    )?;
    exact_fields(
        dependencies,
        "dependencies",
        &["lockAvailable", "lockSha256", "entries", "allVersioned"],
        &[],
    )?;
    let hardware = object(
        root.get("hardware").ok_or("项目验收报告缺少 hardware")?,
        "hardware",
    )?;
    exact_fields(
        hardware,
        "hardware",
        &[
            "state",
            "observedAt",
            "chip",
            "revision",
            "flashBytes",
            "psramBytes",
            "identityIncluded",
        ],
        &[],
    )?;
    if required_bool(
        hardware
            .get("identityIncluded")
            .ok_or("项目验收报告缺少 hardware.identityIncluded")?,
        "hardware.identityIncluded",
    )? {
        return Err("项目验收报告不得包含完整设备身份标识".to_string());
    }
    let history = object(
        root.get("history").ok_or("项目验收报告缺少 history")?,
        "history",
    )?;
    exact_fields(
        history,
        "history",
        &[
            "checkpointCount",
            "latestCheckpointAt",
            "modificationCount",
            "note",
        ],
        &[],
    )?;
    let health = object(
        root.get("health").ok_or("项目验收报告缺少 health")?,
        "health",
    )?;
    exact_fields(health, "health", &["checks", "counts", "summary"], &[])?;
    let counts = object(
        health
            .get("counts")
            .ok_or("项目验收报告缺少 health.counts")?,
        "health.counts",
    )?;
    exact_fields(
        counts,
        "health.counts",
        &["pass", "warning", "error", "info"],
        &[],
    )?;
    let workspace_sha256 = required_string(
        project
            .get("workspaceSha256")
            .ok_or("项目验收报告缺少 project.workspaceSha256")?,
        "project.workspaceSha256",
    )?;
    let generated_code_sha256 = required_string(
        project
            .get("generatedCodeSha256")
            .ok_or("项目验收报告缺少 project.generatedCodeSha256")?,
        "project.generatedCodeSha256",
    )?;
    if !valid_sha256(&workspace_sha256) || !valid_sha256(&generated_code_sha256) {
        return Err("项目验收报告的工程或源码 SHA-256 无效".to_string());
    }
    let compile_state = required_string(
        build.get("state").ok_or("项目验收报告缺少 build.state")?,
        "build.state",
    )?;
    if !["passed", "failed", "not-run", "unverified-target"].contains(&compile_state.as_str()) {
        return Err("项目验收报告 build.state 无效".to_string());
    }
    let hardware_state = required_string(
        hardware
            .get("state")
            .ok_or("项目验收报告缺少 hardware.state")?,
        "hardware.state",
    )?;
    if ![
        "verified",
        "partial",
        "failed",
        "not-checked",
        "unsupported",
    ]
    .contains(&hardware_state.as_str())
    {
        return Err("项目验收报告 hardware.state 无效".to_string());
    }
    let hardware_observed_at = optional_string(hardware.get("observedAt"), "hardware.observedAt")?;
    if hardware_observed_at
        .as_deref()
        .is_some_and(|value| !valid_rfc3339(value))
    {
        return Err("项目验收报告 hardware.observedAt 不是有效 RFC3339 时间".to_string());
    }
    if (hardware_state == "not-checked") != hardware_observed_at.is_none() {
        return Err("项目验收报告 hardware.state 与 observedAt 不一致".to_string());
    }
    optional_string(hardware.get("revision"), "hardware.revision")?;
    let latest_checkpoint_at = optional_string(
        history.get("latestCheckpointAt"),
        "history.latestCheckpointAt",
    )?;
    if latest_checkpoint_at
        .as_deref()
        .is_some_and(|value| !valid_rfc3339(value))
    {
        return Err("项目验收报告 history.latestCheckpointAt 不是有效 RFC3339 时间".to_string());
    }
    let checkpoint_count = required_u64(
        history
            .get("checkpointCount")
            .ok_or("项目验收报告缺少 history.checkpointCount")?,
        "history.checkpointCount",
    )?;
    if (checkpoint_count == 0) != latest_checkpoint_at.is_none() {
        return Err("项目验收报告 checkpointCount 与 latestCheckpointAt 不一致".to_string());
    }
    if !history.get("modificationCount").is_some_and(Value::is_null) {
        return Err("项目验收报告 modificationCount 必须保持未知 null".to_string());
    }
    required_string(
        history.get("note").ok_or("项目验收报告缺少 history.note")?,
        "history.note",
    )?;
    let entries = dependencies
        .get("entries")
        .and_then(Value::as_array)
        .ok_or("项目验收报告 dependencies.entries 无效")?;
    if entries.len() > 4096 {
        return Err("项目验收报告依赖数量超过安全上限".to_string());
    }
    for (index, entry) in entries.iter().enumerate() {
        let entry = object(entry, &format!("dependencies.entries[{index}]"))?;
        exact_fields(
            entry,
            &format!("dependencies.entries[{index}]"),
            &["name", "version", "contentSha256"],
            &[],
        )?;
        required_string(
            entry
                .get("name")
                .ok_or_else(|| format!("dependencies.entries[{index}] 缺少 name"))?,
            &format!("dependencies.entries[{index}].name"),
        )?;
        optional_string(
            entry.get("version"),
            &format!("dependencies.entries[{index}].version"),
        )?;
        let hash = required_string(
            entry
                .get("contentSha256")
                .ok_or_else(|| format!("dependencies.entries[{index}] 缺少 contentSha256"))?,
            &format!("dependencies.entries[{index}].contentSha256"),
        )?;
        if !valid_sha256(&hash) {
            return Err(format!("dependencies.entries[{index}].contentSha256 无效"));
        }
    }
    let dependency_lock_available = required_bool(
        dependencies
            .get("lockAvailable")
            .ok_or("项目验收报告缺少 dependencies.lockAvailable")?,
        "dependencies.lockAvailable",
    )?;
    let dependency_lock_sha256 =
        optional_string(dependencies.get("lockSha256"), "dependencies.lockSha256")?;
    if dependency_lock_available {
        if !dependency_lock_sha256.as_deref().is_some_and(valid_sha256) {
            return Err("验收报告声明依赖锁可用，但 lockSha256 无效".to_string());
        }
    } else if dependency_lock_sha256.is_some() {
        return Err("验收报告声明依赖锁不可用，却携带了 lockSha256".to_string());
    }
    let fqbn = required_string(
        target.get("fqbn").ok_or("项目验收报告缺少 target.fqbn")?,
        "target.fqbn",
    )?;
    let fqbn_parts = fqbn.split(':').collect::<Vec<_>>();
    if fqbn_parts.len() < 3 || fqbn_parts.iter().take(3).any(|part| part.trim().is_empty()) {
        return Err("项目验收报告 target.fqbn 不是完整 FQBN".to_string());
    }
    let core_id = required_string(
        target
            .get("coreId")
            .ok_or("项目验收报告缺少 target.coreId")?,
        "target.coreId",
    )?;
    if core_id != fqbn_parts[..2].join(":") {
        return Err("项目验收报告 target.coreId 与完整 FQBN 不一致".to_string());
    }
    let compile_recorded_at = optional_string(build.get("recordedAt"), "build.recordedAt")?;
    if compile_recorded_at
        .as_deref()
        .is_some_and(|value| !valid_rfc3339(value))
    {
        return Err("项目验收报告 build.recordedAt 不是有效 RFC3339 时间".to_string());
    }
    let build_has_evidence = matches!(compile_state.as_str(), "passed" | "failed");
    if build_has_evidence != compile_recorded_at.is_some() {
        return Err("项目验收报告 build.state 与 recordedAt 证据状态不一致".to_string());
    }
    optional_string(build.get("profile"), "build.profile")?;
    optional_u64(build.get("durationMs"), "build.durationMs")?;
    optional_u64(build.get("warningCount"), "build.warningCount")?;
    let resource_growth = object(
        build
            .get("resourceGrowth")
            .ok_or("项目验收报告缺少 build.resourceGrowth")?,
        "build.resourceGrowth",
    )?;
    exact_fields(
        resource_growth,
        "build.resourceGrowth",
        &[
            "status",
            "flashDeltaBytes",
            "ramDeltaBytes",
            "summary",
            "detail",
            "contributions",
            "evidenceKind",
        ],
        &[],
    )?;
    let growth_status = required_string(
        resource_growth
            .get("status")
            .ok_or("项目验收报告缺少 build.resourceGrowth.status")?,
        "build.resourceGrowth.status",
    )?;
    if ![
        "verified",
        "total-only",
        "no-baseline",
        "incomparable",
        "rejected",
    ]
    .contains(&growth_status.as_str())
    {
        return Err("项目验收报告 build.resourceGrowth.status 无效".to_string());
    }
    let contributions = resource_growth
        .get("contributions")
        .and_then(Value::as_array)
        .ok_or("项目验收报告 build.resourceGrowth.contributions 无效")?;
    if contributions.len() > 512 {
        return Err("项目验收报告资源增长贡献项超过安全上限".to_string());
    }
    for (index, contribution) in contributions.iter().enumerate() {
        let contribution = object(
            contribution,
            &format!("build.resourceGrowth.contributions[{index}]"),
        )?;
        exact_fields(
            contribution,
            &format!("build.resourceGrowth.contributions[{index}]"),
            &[
                "id",
                "label",
                "kind",
                "flashDeltaBytes",
                "ramDeltaBytes",
                "evidence",
            ],
            &[],
        )?;
        let evidence = object(
            contribution
                .get("evidence")
                .ok_or("项目验收报告资源增长贡献项缺少 evidence")?,
            &format!("build.resourceGrowth.contributions[{index}].evidence"),
        )?;
        exact_fields(
            evidence,
            &format!("build.resourceGrowth.contributions[{index}].evidence"),
            &["kind", "locator", "sha256", "baselineSha256"],
            &[],
        )?;
        for hash_field in ["sha256", "baselineSha256"] {
            let hash = required_string(
                evidence
                    .get(hash_field)
                    .ok_or_else(|| format!("资源增长贡献项 evidence 缺少 {hash_field}"))?,
                hash_field,
            )?;
            if !valid_sha256(&hash) {
                return Err("项目验收报告资源增长贡献项 SHA-256 无效".to_string());
            }
        }
    }
    let flash_used_bytes = optional_u64(build.get("flashUsedBytes"), "build.flashUsedBytes")?;
    let flash_total_bytes = optional_u64(build.get("flashTotalBytes"), "build.flashTotalBytes")?;
    let ram_used_bytes = optional_u64(build.get("ramUsedBytes"), "build.ramUsedBytes")?;
    let ram_total_bytes = optional_u64(build.get("ramTotalBytes"), "build.ramTotalBytes")?;
    if flash_used_bytes.is_some() != flash_total_bytes.is_some()
        || ram_used_bytes.is_some() != ram_total_bytes.is_some()
    {
        return Err("项目验收报告资源已用量与总量必须同时存在或同时为空".to_string());
    }
    if !build_has_evidence
        && (flash_used_bytes.is_some()
            || flash_total_bytes.is_some()
            || ram_used_bytes.is_some()
            || ram_total_bytes.is_some())
    {
        return Err("项目验收报告没有当前构建证据却携带资源用量".to_string());
    }
    if flash_used_bytes
        .zip(flash_total_bytes)
        .is_some_and(|(used, total)| used > total)
        || ram_used_bytes
            .zip(ram_total_bytes)
            .is_some_and(|(used, total)| used > total)
    {
        return Err("项目验收报告资源使用量不能超过对应总量".to_string());
    }
    let health_pass_count = count_health_state(counts, "pass")?;
    let health_warning_count = count_health_state(counts, "warning")?;
    let health_error_count = count_health_state(counts, "error")?;
    let health_info_count = count_health_state(counts, "info")?;
    let checks = health
        .get("checks")
        .and_then(Value::as_array)
        .ok_or("项目验收报告 health.checks 无效")?;
    if checks.len() > 256 {
        return Err("项目验收报告健康检查项超过安全上限".to_string());
    }
    let mut actual_health_counts = BTreeMap::from([
        ("pass", 0u64),
        ("warning", 0u64),
        ("error", 0u64),
        ("info", 0u64),
    ]);
    for (index, check) in checks.iter().enumerate() {
        let check = object(check, &format!("health.checks[{index}]"))?;
        exact_fields(
            check,
            &format!("health.checks[{index}]"),
            &["id", "state", "title", "detail", "evidence"],
            &["stages"],
        )?;
        let state = required_string(
            check
                .get("state")
                .ok_or_else(|| format!("health.checks[{index}] 缺少 state"))?,
            &format!("health.checks[{index}].state"),
        )?;
        let count = actual_health_counts
            .get_mut(state.as_str())
            .ok_or_else(|| format!("health.checks[{index}].state 无效"))?;
        *count += 1;
    }
    let check_count = checks.len() as u64;
    if health_pass_count
        .saturating_add(health_warning_count)
        .saturating_add(health_error_count)
        .saturating_add(health_info_count)
        != check_count
    {
        return Err("项目验收报告 health.counts 与检查项数量不一致".to_string());
    }
    if actual_health_counts["pass"] != health_pass_count
        || actual_health_counts["warning"] != health_warning_count
        || actual_health_counts["error"] != health_error_count
        || actual_health_counts["info"] != health_info_count
    {
        return Err("项目验收报告 health.counts 与每个检查项状态不一致".to_string());
    }
    let expected_health_summary = if health_error_count > 0 {
        format!("{health_error_count} 个确定问题，{health_warning_count} 个警告")
    } else if health_warning_count > 0 {
        format!("无确定错误，{health_warning_count} 个警告")
    } else {
        "当前检查项未发现确定问题".to_string()
    };
    let health_summary = required_string(
        health
            .get("summary")
            .ok_or("项目验收报告缺少 health.summary")?,
        "health.summary",
    )?;
    if health_summary != expected_health_summary {
        return Err("项目验收报告 health.summary 与检查项状态不一致".to_string());
    }
    let all_versioned = entries.iter().all(|entry| {
        entry
            .get("version")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
            && entry
                .get("contentSha256")
                .and_then(Value::as_str)
                .is_some_and(valid_sha256)
    });
    let declared_all_versioned = required_bool(
        dependencies
            .get("allVersioned")
            .ok_or("项目验收报告缺少 dependencies.allVersioned")?,
        "dependencies.allVersioned",
    )?;
    if declared_all_versioned != (dependency_lock_available && all_versioned) {
        return Err("项目验收报告 dependencies.allVersioned 与锁和依赖条目不一致".to_string());
    }
    Ok(ProjectSubmissionSummary {
        project_name: required_string(
            project.get("name").ok_or("项目验收报告缺少 project.name")?,
            "project.name",
        )?,
        block_count: required_u64(
            project
                .get("blockCount")
                .ok_or("项目验收报告缺少 project.blockCount")?,
            "project.blockCount",
        )?,
        workspace_sha256,
        generated_code_sha256,
        board_name: required_string(
            target
                .get("boardName")
                .ok_or("项目验收报告缺少 target.boardName")?,
            "target.boardName",
        )?,
        board_id: required_string(
            target
                .get("boardId")
                .ok_or("项目验收报告缺少 target.boardId")?,
            "target.boardId",
        )?,
        board_package_id: required_string(
            target
                .get("boardPackageId")
                .ok_or("项目验收报告缺少 target.boardPackageId")?,
            "target.boardPackageId",
        )?,
        fqbn,
        core_id,
        core_version: optional_string(target.get("coreVersion"), "target.coreVersion")?,
        compile_state,
        compile_recorded_at,
        flash_used_bytes,
        flash_total_bytes,
        ram_used_bytes,
        ram_total_bytes,
        dependency_lock_available,
        dependency_lock_sha256,
        dependency_count: entries.len() as u64,
        dependencies_all_versioned: declared_all_versioned,
        hardware_state,
        hardware_chip: optional_string(hardware.get("chip"), "hardware.chip")?,
        hardware_flash_bytes: optional_u64(hardware.get("flashBytes"), "hardware.flashBytes")?,
        hardware_psram_bytes: optional_u64(hardware.get("psramBytes"), "hardware.psramBytes")?,
        checkpoint_count,
        health_summary,
        health_pass_count,
        health_warning_count,
        health_error_count,
        health_info_count,
    })
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn bytes_label(value: Option<u64>) -> String {
    match value {
        None => "未报告".to_string(),
        Some(value) if value < 1024 => format!("{value} B"),
        Some(value) if value < 1024 * 1024 => format!("{:.1} KiB", value as f64 / 1024.0),
        Some(value) => format!("{:.2} MiB", value as f64 / 1024.0 / 1024.0),
    }
}

fn html_multiline(value: &str) -> String {
    escape_html(value)
        .replace("\r\n", "<br>")
        .replace(['\r', '\n'], "<br>")
}

fn report_detail_html(report: &Value) -> Result<String, String> {
    let root = object(report, "report")?;
    let project = object(
        root.get("project").ok_or("项目验收报告缺少 project")?,
        "project",
    )?;
    let structure = object(
        project
            .get("structure")
            .ok_or("项目验收报告缺少 project.structure")?,
        "project.structure",
    )?;
    exact_fields(
        structure,
        "project.structure",
        &["available", "topLevelFlowCount", "blockTypes"],
        &[],
    )?;
    let structure_available = required_bool(
        structure
            .get("available")
            .ok_or("项目验收报告缺少 project.structure.available")?,
        "project.structure.available",
    )?;
    let flow_count = optional_u64(
        structure.get("topLevelFlowCount"),
        "project.structure.topLevelFlowCount",
    )?;
    let block_types = structure
        .get("blockTypes")
        .and_then(Value::as_array)
        .ok_or("项目验收报告 project.structure.blockTypes 无效")?;
    if block_types.len() > 4096 {
        return Err("项目验收报告积木类型数量超过安全上限".to_string());
    }
    let block_type_rows = block_types
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let item = object(item, &format!("project.structure.blockTypes[{index}]"))?;
            exact_fields(
                item,
                &format!("project.structure.blockTypes[{index}]"),
                &["type", "count"],
                &[],
            )?;
            let kind = required_string(
                item.get("type")
                    .ok_or_else(|| format!("project.structure.blockTypes[{index}] 缺少 type"))?,
                &format!("project.structure.blockTypes[{index}].type"),
            )?;
            let count = required_u64(
                item.get("count")
                    .ok_or_else(|| format!("project.structure.blockTypes[{index}] 缺少 count"))?,
                &format!("project.structure.blockTypes[{index}].count"),
            )?;
            Ok(format!(
                "<li><code>{}</code> × {count}</li>",
                escape_html(&kind)
            ))
        })
        .collect::<Result<String, String>>()?;
    let structure_section = if structure_available {
        format!(
            "<h2>软件结构</h2><div class=\"card\"><div class=\"value\">{} 条顶层流程</div><ul>{}</ul></div>",
            flow_count.map_or_else(|| "未报告".to_string(), |value| value.to_string()),
            if block_type_rows.is_empty() {
                "<li>未识别积木类型</li>".to_string()
            } else {
                block_type_rows
            }
        )
    } else {
        "<h2>软件结构</h2><div class=\"card\">工作区结构不可解析；未生成积木截图。</div>"
            .to_string()
    };

    let notes = object(root.get("notes").ok_or("项目验收报告缺少 notes")?, "notes")?;
    exact_fields(notes, "notes", &["circuitDescription", "testRecords"], &[])?;
    let circuit = optional_string(notes.get("circuitDescription"), "notes.circuitDescription")?;
    let tests = optional_string(notes.get("testRecords"), "notes.testRecords")?;
    let notes_section = format!(
        "<h2>电路说明与测试记录</h2><div class=\"grid\"><div class=\"card\"><div class=\"label\">电路说明</div><div>{}</div></div><div class=\"card\"><div class=\"label\">测试记录</div><div>{}</div></div></div>",
        circuit
            .as_deref()
            .map(html_multiline)
            .unwrap_or_else(|| "未填写".to_string()),
        tests
            .as_deref()
            .map(html_multiline)
            .unwrap_or_else(|| "未填写".to_string()),
    );

    let health = object(
        root.get("health").ok_or("项目验收报告缺少 health")?,
        "health",
    )?;
    let checks = health
        .get("checks")
        .and_then(Value::as_array)
        .ok_or("项目验收报告 health.checks 无效")?;
    if checks.len() > 256 {
        return Err("项目验收报告健康检查项超过安全上限".to_string());
    }
    let check_rows = checks
        .iter()
        .enumerate()
        .map(|(index, check)| {
            let check = object(check, &format!("health.checks[{index}]"))?;
            exact_fields(
                check,
                &format!("health.checks[{index}]"),
                &["id", "state", "title", "detail", "evidence"],
                &["stages"],
            )?;
            let state = required_string(
                check
                    .get("state")
                    .ok_or_else(|| format!("health.checks[{index}] 缺少 state"))?,
                &format!("health.checks[{index}].state"),
            )?;
            if !["pass", "warning", "error", "info"].contains(&state.as_str()) {
                return Err(format!("health.checks[{index}].state 无效"));
            }
            let title = required_string(
                check
                    .get("title")
                    .ok_or_else(|| format!("health.checks[{index}] 缺少 title"))?,
                &format!("health.checks[{index}].title"),
            )?;
            let detail = required_string(
                check
                    .get("detail")
                    .ok_or_else(|| format!("health.checks[{index}] 缺少 detail"))?,
                &format!("health.checks[{index}].detail"),
            )?;
            let evidence = optional_string(
                check.get("evidence"),
                &format!("health.checks[{index}].evidence"),
            )?;
            let stages = match check.get("stages") {
                None | Some(Value::Null) => String::new(),
                Some(Value::Array(stages)) => {
                    if stages.len() > 4 {
                        return Err(format!("health.checks[{index}].stages 超过四级护照上限"));
                    }
                    let items = stages
                        .iter()
                        .enumerate()
                        .map(|(stage_index, stage)| {
                            let stage = object(
                                stage,
                                &format!("health.checks[{index}].stages[{stage_index}]"),
                            )?;
                            exact_fields(
                                stage,
                                &format!("health.checks[{index}].stages[{stage_index}]"),
                                &["id", "state", "title", "detail", "checkedAt"],
                                &[],
                            )?;
                            let stage_state = required_string(
                                stage.get("state").ok_or_else(|| {
                                    format!(
                                        "health.checks[{index}].stages[{stage_index}] 缺少 state"
                                    )
                                })?,
                                &format!("health.checks[{index}].stages[{stage_index}].state"),
                            )?;
                            if !["pass", "warning", "error", "info"].contains(&stage_state.as_str())
                            {
                                return Err(format!(
                                    "health.checks[{index}].stages[{stage_index}].state 无效"
                                ));
                            }
                            let stage_title = required_string(
                                stage.get("title").ok_or_else(|| {
                                    format!(
                                        "health.checks[{index}].stages[{stage_index}] 缺少 title"
                                    )
                                })?,
                                &format!("health.checks[{index}].stages[{stage_index}].title"),
                            )?;
                            let stage_detail = required_string(
                                stage.get("detail").ok_or_else(|| {
                                    format!(
                                        "health.checks[{index}].stages[{stage_index}] 缺少 detail"
                                    )
                                })?,
                                &format!("health.checks[{index}].stages[{stage_index}].detail"),
                            )?;
                            Ok(format!(
                                "<li><strong>{}</strong> [{}] — {}</li>",
                                escape_html(&stage_title),
                                escape_html(&stage_state),
                                escape_html(&stage_detail)
                            ))
                        })
                        .collect::<Result<String, String>>()?;
                    format!(
                        "<div class=\"passport\"><strong>板卡护照：</strong><ul>{items}</ul></div>"
                    )
                }
                Some(_) => return Err(format!("health.checks[{index}].stages 必须是数组")),
            };
            Ok(format!(
                "<tr><td>{}</td><td><strong>{}</strong><br>{}{}</td><td><code>{}</code></td></tr>",
                escape_html(&state),
                escape_html(&title),
                escape_html(&detail),
                stages,
                escape_html(evidence.as_deref().unwrap_or("—")),
            ))
        })
        .collect::<Result<String, String>>()?;
    let health_section = format!(
        "<h2>工程健康检查</h2><table><thead><tr><th>状态</th><th>检查项</th><th>证据</th></tr></thead><tbody>{}</tbody></table>",
        if check_rows.is_empty() {
            "<tr><td colspan=\"3\">没有检查项</td></tr>".to_string()
        } else {
            check_rows
        }
    );

    let dependencies = object(
        root.get("dependencies")
            .ok_or("项目验收报告缺少 dependencies")?,
        "dependencies",
    )?;
    let dependency_items = dependency_contracts(report)?
        .iter()
        .map(|(name, version, hash)| {
            format!(
                "<li>{} @ {} <code>{}…</code></li>",
                escape_html(name),
                escape_html(version.as_deref().unwrap_or("未标版本")),
                escape_html(&hash[..12]),
            )
        })
        .collect::<String>();
    let dependency_section = format!(
        "<h2>依赖锁</h2><p>{}</p><ul>{}</ul>",
        if dependencies.get("lockAvailable").and_then(Value::as_bool) == Some(true) {
            "已记录与当前工程匹配的 ck.lock"
        } else {
            "尚无与当前工程匹配的可信 ck.lock"
        },
        if dependency_items.is_empty() {
            "<li>无已记录的第三方依赖</li>".to_string()
        } else {
            dependency_items
        }
    );
    let limitations = root
        .get("limitations")
        .and_then(Value::as_array)
        .ok_or("项目验收报告 limitations 无效")?;
    if limitations.len() > 128 {
        return Err("项目验收报告限制说明超过安全上限".to_string());
    }
    let limitation_items = limitations
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let text = required_string(item, &format!("limitations[{index}]"))?;
            Ok(format!("<li>{}</li>", escape_html(&text)))
        })
        .collect::<Result<String, String>>()?;
    Ok(format!(
        "{structure_section}{notes_section}{health_section}{dependency_section}<h2>证据边界</h2><ul>{limitation_items}</ul>"
    ))
}

fn printable_html(
    report: &Value,
    summary: &ProjectSubmissionSummary,
    generated_at: &str,
) -> Result<Vec<u8>, String> {
    let details = report_detail_html(report)?;
    let html = format!(
        r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{project} - CK 项目验收报告</title><style>body{{font:14px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;color:#172033;max-width:920px;margin:32px auto;padding:0 24px}}h1{{margin-bottom:4px}}h2{{margin-top:26px;border-bottom:1px solid #dbe3ec;padding-bottom:5px}}.meta{{color:#64748b}}.grid{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}}.card{{border:1px solid #dbe3ec;border-radius:10px;padding:12px;overflow-wrap:anywhere}}.label{{font-size:11px;color:#64748b}}.value{{font-weight:700;margin-top:3px}}code{{font:12px ui-monospace,monospace;overflow-wrap:anywhere}}table{{width:100%;border-collapse:collapse}}th,td{{text-align:left;vertical-align:top;border-bottom:1px solid #e5eaf0;padding:8px}}.passport{{margin-top:6px}}@media(max-width:640px){{.grid{{grid-template-columns:1fr}}}}@media print{{body{{margin:0;max-width:none}}.card,tr{{break-inside:avoid}}h2{{break-after:avoid}}}}</style></head><body><h1>CK 项目验收报告</h1><div class="meta">提交包生成时间：{generated_at} · 本文件不含脚本</div><h2>工程与目标</h2><div class="grid"><div class="card"><div class="label">工程</div><div class="value">{project}</div><div>{blocks} 个积木</div></div><div class="card"><div class="label">板卡</div><div class="value">{board}</div><code>{fqbn}</code></div><div class="card"><div class="label">Core</div><div class="value">{core}@{version}</div></div><div class="card"><div class="label">编译</div><div class="value">{compile}</div><div>{recorded}</div></div></div><h2>资源、依赖与真机</h2><div class="grid"><div class="card"><div class="label">Flash</div><div class="value">{flash_used} / {flash_total}</div></div><div class="card"><div class="label">RAM</div><div class="value">{ram_used} / {ram_total}</div></div><div class="card"><div class="label">依赖</div><div class="value">锁：{lock}；{deps} 项</div><div>全部固定版本：{versioned}</div></div><div class="card"><div class="label">真机</div><div class="value">{hardware}</div><div>{chip}</div></div></div><h2>工程健康与历史</h2><div class="grid"><div class="card"><div class="label">检查项</div><div class="value">{health}</div><div>通过 {pass} · 警告 {warning} · 问题 {error} · 提示 {info}</div></div><div class="card"><div class="label">检查点</div><div class="value">{checkpoints}</div></div></div>{details}<p class="meta">完整性校验只能证明容器在本次打开时自洽，不等同于发布者身份签名。编译通过也不等同于物理外设已验证。可编辑工程和生成源码仅在提交者明确选择后才会进入容器；本报告不自动生成积木截图。</p></body></html>"#,
        project = escape_html(&summary.project_name),
        generated_at = escape_html(generated_at),
        blocks = summary.block_count,
        board = escape_html(&summary.board_name),
        fqbn = escape_html(&summary.fqbn),
        core = escape_html(&summary.core_id),
        version = escape_html(summary.core_version.as_deref().unwrap_or("未识别")),
        compile = escape_html(&summary.compile_state),
        recorded = escape_html(
            summary
                .compile_recorded_at
                .as_deref()
                .unwrap_or("无匹配证据")
        ),
        flash_used = bytes_label(summary.flash_used_bytes),
        flash_total = bytes_label(summary.flash_total_bytes),
        ram_used = bytes_label(summary.ram_used_bytes),
        ram_total = bytes_label(summary.ram_total_bytes),
        lock = if summary.dependency_lock_available {
            "已验证记录"
        } else {
            "不可用"
        },
        deps = summary.dependency_count,
        versioned = if summary.dependencies_all_versioned {
            "是"
        } else {
            "否/未知"
        },
        hardware = escape_html(&summary.hardware_state),
        chip = escape_html(summary.hardware_chip.as_deref().unwrap_or("未报告芯片")),
        health = escape_html(&summary.health_summary),
        pass = summary.health_pass_count,
        warning = summary.health_warning_count,
        error = summary.health_error_count,
        info = summary.health_info_count,
        checkpoints = summary.checkpoint_count,
        details = details,
    );
    validate_printable_html(&html)?;
    Ok(html.into_bytes())
}

fn validate_printable_html(html: &str) -> Result<(), String> {
    let lower = html.to_ascii_lowercase();
    let forbidden_tags = Regex::new(
        r"(?i)<\s*(script|link|img|svg|iframe|object|embed|form|base|video|audio|canvas)\b",
    )
    .expect("static regex");
    let event_handler = Regex::new(r"(?i)<[a-z][^>]*\bon[a-z0-9_-]+\s*=").expect("static regex");
    let active_uri = Regex::new(
        r#"(?i)<[a-z][^>]*\b(href|src|action|poster|formaction)\s*=\s*['\"]?\s*(javascript|https?|file|data):"#,
    )
    .expect("static regex");
    let meta_refresh = Regex::new(r"(?i)<\s*meta\b[^>]*http-equiv\s*=|<\s*meta\b[^>]*url\s*=")
        .expect("static regex");
    let css_external = Regex::new(r"(?i)@import|url\s*\(").expect("static regex");
    if forbidden_tags.is_match(html)
        || event_handler.is_match(html)
        || active_uri.is_match(html)
        || meta_refresh.is_match(html)
        || css_external.is_match(html)
        || !lower.starts_with("<!doctype html>")
    {
        return Err("project.ckpkg 可打印 HTML 含脚本、事件、外链或主动内容".to_string());
    }
    Ok(())
}

fn size_limit(path: &str) -> Option<u64> {
    match path {
        MANIFEST_PATH => Some(MAX_MANIFEST_BYTES),
        REPORT_JSON_PATH => Some(MAX_REPORT_BYTES),
        REPORT_HTML_PATH => Some(MAX_HTML_BYTES),
        WORKSPACE_PATH => Some(MAX_WORKSPACE_BYTES),
        GENERATED_SOURCE_PATH => Some(MAX_SOURCE_BYTES),
        LOCK_PATH => Some(MAX_LOCK_BYTES),
        BUILD_EVIDENCE_PATH => Some(MAX_BUILD_EVIDENCE_BYTES),
        MARKER_PATH => Some(MARKER_CONTENT.len() as u64),
        _ => None,
    }
}

fn push_prepared(
    files: &mut Vec<PreparedFile>,
    path: &'static str,
    role: ProjectSubmissionFileRole,
    bytes: Vec<u8>,
    redacted: bool,
) -> Result<(), String> {
    let limit = size_limit(path).ok_or_else(|| format!("项目提交包不允许路径 {path}"))?;
    if bytes.is_empty() || bytes.len() as u64 > limit {
        return Err(format!("项目提交包内容 {path} 大小无效"));
    }
    files.push(PreparedFile {
        path,
        role,
        bytes,
        redacted,
    });
    Ok(())
}

fn dependency_contracts(value: &Value) -> Result<Vec<(String, Option<String>, String)>, String> {
    let root = object(value, "report")?;
    let dependencies = object(
        root.get("dependencies")
            .ok_or("项目验收报告缺少 dependencies")?,
        "dependencies",
    )?;
    let entries = dependencies
        .get("entries")
        .and_then(Value::as_array)
        .ok_or("项目验收报告 dependencies.entries 无效")?;
    let mut contracts = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let entry = object(entry, &format!("dependencies.entries[{index}]"))?;
            Ok((
                required_string(
                    entry
                        .get("name")
                        .ok_or_else(|| format!("dependencies.entries[{index}] 缺少 name"))?,
                    &format!("dependencies.entries[{index}].name"),
                )?,
                optional_string(
                    entry.get("version"),
                    &format!("dependencies.entries[{index}].version"),
                )?,
                required_string(
                    entry.get("contentSha256").ok_or_else(|| {
                        format!("dependencies.entries[{index}] 缺少 contentSha256")
                    })?,
                    &format!("dependencies.entries[{index}].contentSha256"),
                )?
                .to_ascii_lowercase(),
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    contracts.sort();
    Ok(contracts)
}

fn sanitize_lock(
    raw: &str,
    summary: &ProjectSubmissionSummary,
    report: &Value,
) -> Result<Vec<u8>, String> {
    if raw.is_empty() || raw.len() as u64 > MAX_LOCK_BYTES {
        return Err("ck.lock 大小无效".to_string());
    }
    let value: Value =
        serde_json::from_str(raw).map_err(|error| format!("ck.lock JSON 无效：{error}"))?;
    let root = object(&value, "ck.lock")?;
    let original_hash = sha256_bytes(raw.as_bytes());
    if summary.dependency_lock_sha256.as_deref() != Some(original_hash.as_str()) {
        return Err("ck.lock 原始 SHA-256 与本次验收报告不一致，请重新生成报告".to_string());
    }
    let dependencies = root
        .get("dependencies")
        .and_then(Value::as_array)
        .ok_or("ck.lock 缺少 dependencies")?;
    if dependencies.len() as u64 != summary.dependency_count {
        return Err("ck.lock 依赖数量与验收摘要不一致".to_string());
    }
    let mut lock_contracts = Vec::with_capacity(dependencies.len());
    let sanitized_dependencies = dependencies
        .iter()
        .map(|dependency| {
            let item = dependency.as_object().ok_or("ck.lock 依赖项必须是对象")?;
            let name = required_string(
                item.get("name").ok_or("ck.lock 依赖项缺少 name")?,
                "ck.lock.dependencies.name",
            )?;
            let version = optional_string(item.get("version"), "ck.lock.dependencies.version")?;
            let content_sha256 = required_string(
                item.get("contentSha256")
                    .ok_or("ck.lock 依赖项缺少 contentSha256")?,
                "ck.lock.dependencies.contentSha256",
            )?;
            if !valid_sha256(&content_sha256) {
                return Err("ck.lock 依赖内容 SHA-256 无效".to_string());
            }
            lock_contracts.push((
                name.clone(),
                version.clone(),
                content_sha256.to_ascii_lowercase(),
            ));
            Ok(json!({
                "name": name,
                "version": version,
                "contentSha256": content_sha256,
                "fileCount": item.get("fileCount").and_then(Value::as_u64),
                "totalBytes": item.get("totalBytes").and_then(Value::as_u64),
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    lock_contracts.sort();
    if lock_contracts != dependency_contracts(report)? {
        return Err("ck.lock 依赖条目与本次验收报告不一致".to_string());
    }
    let sanitized = json!({
        "schemaVersion": root.get("schemaVersion").and_then(Value::as_u64).unwrap_or(1),
        "createdAt": root.get("createdAt").and_then(Value::as_str),
        "fqbn": summary.fqbn,
        "boardPackageId": summary.board_package_id,
        "core": {
            "id": summary.core_id,
            "version": summary.core_version,
        },
        "dependencies": sanitized_dependencies,
        "privacy": {
            "redacted": true,
            "omittedFields": ["sourcePath", "snapshotPath", "local paths"],
        },
    });
    serde_json::to_vec_pretty(&sanitized)
        .map_err(|error| format!("无法序列化脱敏 ck.lock：{error}"))
}

fn validate_sanitized_lock(
    bytes: &[u8],
    summary: &ProjectSubmissionSummary,
    report: &Value,
) -> Result<(), String> {
    let lock: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("project.ckpkg 的 ck.lock JSON 无效：{error}"))?;
    let root = object(&lock, "ck.lock")?;
    let allowed = BTreeSet::from([
        "schemaVersion",
        "createdAt",
        "fqbn",
        "boardPackageId",
        "core",
        "dependencies",
        "privacy",
    ]);
    if root.keys().any(|key| !allowed.contains(key.as_str())) {
        return Err("project.ckpkg 的脱敏 ck.lock 含未允许字段".to_string());
    }
    if root.get("schemaVersion").and_then(Value::as_u64).is_none() {
        return Err("project.ckpkg 的 ck.lock schemaVersion 无效".to_string());
    }
    if let Some(created_at) = optional_string(root.get("createdAt"), "ck.lock.createdAt")? {
        if !valid_rfc3339(&created_at) {
            return Err("project.ckpkg 的 ck.lock createdAt 无效".to_string());
        }
    }
    if root.get("fqbn").and_then(Value::as_str) != Some(summary.fqbn.as_str())
        || root.get("boardPackageId").and_then(Value::as_str)
            != Some(summary.board_package_id.as_str())
    {
        return Err("project.ckpkg 的 ck.lock 与完整 FQBN/板卡包不一致".to_string());
    }
    let core = object(root.get("core").ok_or("ck.lock 缺少 core")?, "ck.lock.core")?;
    if core
        .keys()
        .any(|key| !["id", "version"].contains(&key.as_str()))
        || core.get("id").and_then(Value::as_str) != Some(summary.core_id.as_str())
        || optional_string(core.get("version"), "ck.lock.core.version")?.as_deref()
            != summary.core_version.as_deref()
    {
        return Err("project.ckpkg 的 ck.lock 与 Core 证据不一致".to_string());
    }
    let privacy = object(
        root.get("privacy").ok_or("ck.lock 缺少 privacy")?,
        "ck.lock.privacy",
    )?;
    if privacy.get("redacted").and_then(Value::as_bool) != Some(true)
        || privacy
            .get("omittedFields")
            .and_then(Value::as_array)
            .is_none()
    {
        return Err("project.ckpkg 的 ck.lock 未声明路径脱敏".to_string());
    }
    let dependencies = root
        .get("dependencies")
        .and_then(Value::as_array)
        .ok_or("project.ckpkg 的 ck.lock 缺少 dependencies")?;
    let mut actual = dependencies
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let item = object(item, &format!("ck.lock.dependencies[{index}]"))?;
            if item.keys().any(|key| {
                ![
                    "name",
                    "version",
                    "contentSha256",
                    "fileCount",
                    "totalBytes",
                ]
                .contains(&key.as_str())
            }) {
                return Err(format!("ck.lock.dependencies[{index}] 含未允许字段"));
            }
            Ok((
                required_string(
                    item.get("name")
                        .ok_or_else(|| format!("ck.lock.dependencies[{index}] 缺少 name"))?,
                    &format!("ck.lock.dependencies[{index}].name"),
                )?,
                optional_string(
                    item.get("version"),
                    &format!("ck.lock.dependencies[{index}].version"),
                )?,
                required_string(
                    item.get("contentSha256").ok_or_else(|| {
                        format!("ck.lock.dependencies[{index}] 缺少 contentSha256")
                    })?,
                    &format!("ck.lock.dependencies[{index}].contentSha256"),
                )?
                .to_ascii_lowercase(),
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    actual.sort();
    if actual != dependency_contracts(report)? {
        return Err("project.ckpkg 的 ck.lock 依赖条目与验收报告不一致".to_string());
    }
    Ok(())
}

fn build_evidence(report: &Value, summary: &ProjectSubmissionSummary) -> Result<Vec<u8>, String> {
    let root = object(report, "report")?;
    let evidence = json!({
        "schemaVersion": 1,
        "kind": "ck-build-evidence-summary",
        "target": {
            "boardName": summary.board_name,
            "boardId": summary.board_id,
            "boardPackageId": summary.board_package_id,
            "fqbn": summary.fqbn,
            "coreId": summary.core_id,
            "coreVersion": summary.core_version,
        },
        "project": {
            "workspaceSha256": summary.workspace_sha256,
            "generatedCodeSha256": summary.generated_code_sha256,
        },
        "build": root.get("build").cloned().unwrap_or(Value::Null),
        "dependencies": root.get("dependencies").cloned().unwrap_or(Value::Null),
        "hardware": root.get("hardware").cloned().unwrap_or(Value::Null),
        "history": root.get("history").cloned().unwrap_or(Value::Null),
        "health": root.get("health").cloned().unwrap_or(Value::Null),
        "networkUsed": false,
        "uploadPerformed": false,
    });
    serde_json::to_vec_pretty(&evidence).map_err(|error| format!("无法序列化构建证据：{error}"))
}

fn plan_export(
    request: &ProjectSubmissionExportRequest,
) -> Result<(ProjectSubmissionSummary, String, Vec<PreparedFile>), String> {
    let summary = summary_from_report(&request.report)?;
    if request.source_scope != ProjectSourceScope::NoSource
        && !request.source_disclosure_acknowledged
    {
        return Err("包含可编辑工程或生成源码前，必须明确确认敏感信息风险".to_string());
    }
    if request.source_scope == ProjectSourceScope::NoSource
        && request.source_disclosure_acknowledged
    {
        return Err("不含源码档不得伪造源码披露确认".to_string());
    }
    if !request.source_scope.includes_workspace() && request.workspace_json.is_some() {
        return Err("当前源码范围未选择可编辑积木工程，但请求携带了 workspaceJson".to_string());
    }
    if !request.source_scope.includes_generated_source() && request.generated_source.is_some() {
        return Err("当前源码范围未选择生成源码，但请求携带了 generatedSource".to_string());
    }
    let generated_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let report_bytes = serde_json::to_vec_pretty(&request.report)
        .map_err(|error| format!("无法编码项目验收报告：{error}"))?;
    let html_bytes = printable_html(&request.report, &summary, &generated_at)?;
    let mut files = Vec::new();
    push_prepared(
        &mut files,
        REPORT_JSON_PATH,
        ProjectSubmissionFileRole::AcceptanceReport,
        report_bytes,
        true,
    )?;
    push_prepared(
        &mut files,
        REPORT_HTML_PATH,
        ProjectSubmissionFileRole::PrintableReport,
        html_bytes,
        true,
    )?;
    if request.source_scope.includes_workspace() {
        let workspace = request
            .workspace_json
            .as_deref()
            .ok_or("源码范围选择了可编辑工程，但缺少 workspaceJson")?;
        let parsed: Value = serde_json::from_str(workspace)
            .map_err(|error| format!("可编辑积木工程 JSON 无效：{error}"))?;
        if !parsed.is_object() {
            return Err("可编辑积木工程必须是 JSON 对象".to_string());
        }
        if sha256_bytes(workspace.as_bytes()) != summary.workspace_sha256.to_ascii_lowercase() {
            return Err("可编辑积木工程与本次验收报告的 SHA-256 不一致，请刷新后重试".to_string());
        }
        push_prepared(
            &mut files,
            WORKSPACE_PATH,
            ProjectSubmissionFileRole::EditableProject,
            workspace.as_bytes().to_vec(),
            false,
        )?;
    }
    if request.source_scope.includes_generated_source() {
        let source = request
            .generated_source
            .as_deref()
            .ok_or("源码范围选择了生成源码，但请求未携带源码")?;
        if sha256_bytes(source.as_bytes()) != summary.generated_code_sha256.to_ascii_lowercase() {
            return Err("生成源码与本次验收报告的 SHA-256 不一致，请刷新后重试".to_string());
        }
        push_prepared(
            &mut files,
            GENERATED_SOURCE_PATH,
            ProjectSubmissionFileRole::GeneratedSource,
            source.as_bytes().to_vec(),
            false,
        )?;
    }
    if let Some(lock) = request.ck_lock.as_deref() {
        if !summary.dependency_lock_available {
            return Err("当前验收报告没有可用依赖锁，不能附加 ck.lock".to_string());
        }
        let sanitized = sanitize_lock(lock, &summary, &request.report)?;
        push_prepared(
            &mut files,
            LOCK_PATH,
            ProjectSubmissionFileRole::DependencyLock,
            sanitized,
            true,
        )?;
    }
    if request.include_build_evidence {
        let evidence = build_evidence(&request.report, &summary)?;
        push_prepared(
            &mut files,
            BUILD_EVIDENCE_PATH,
            ProjectSubmissionFileRole::BuildEvidence,
            evidence,
            true,
        )?;
    }
    let total = files
        .iter()
        .try_fold(0u64, |total, file| {
            total.checked_add(file.bytes.len() as u64)
        })
        .ok_or("项目提交包内容大小溢出")?;
    if total > MAX_TOTAL_UNCOMPRESSED_BYTES {
        return Err("项目提交包内容超过 32 MiB 安全上限".to_string());
    }
    Ok((summary, generated_at, files))
}

fn ensure_output_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("项目提交包输出路径不能为空".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("ckpkg"))
    {
        return Err("项目提交包必须使用 .ckpkg 扩展名".to_string());
    }
    if path.exists() {
        return Err("输出文件已存在，请选择新的文件名".to_string());
    }
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or("项目提交包输出路径缺少父目录")?;
    if !parent.is_dir() {
        return Err("项目提交包输出目录不存在".to_string());
    }
    Ok(path)
}

fn write_entry(
    writer: &mut ZipWriter<File>,
    path: &str,
    bytes: &[u8],
    options: SimpleFileOptions,
) -> Result<(), String> {
    writer
        .start_file(path, options)
        .map_err(|error| format!("无法创建项目提交包条目 {path}：{error}"))?;
    writer
        .write_all(bytes)
        .map_err(|error| format!("无法写入项目提交包条目 {path}：{error}"))
}

pub fn export_package(
    request: ProjectSubmissionExportRequest,
) -> Result<ProjectSubmissionExportResult, String> {
    let output_path = ensure_output_path(&request.output_path)?;
    let (summary, generated_at, mut files) = plan_export(&request)?;
    files.sort_by_key(|file| file.path);
    let has_dependency_lock = files.iter().any(|file| file.path == LOCK_PATH);
    let has_build_evidence = files.iter().any(|file| file.path == BUILD_EVIDENCE_PATH);
    let records = files
        .iter()
        .map(|file| ProjectSubmissionFileRecord {
            path: file.path.to_string(),
            role: file.role.clone(),
            size: file.bytes.len() as u64,
            sha256: sha256_bytes(&file.bytes),
            redacted: file.redacted,
        })
        .collect::<Vec<_>>();
    let generated_by = GeneratedBy {
        product: "CK Desktop".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        component: "project-submission-exporter".to_string(),
    };
    let manifest = ProjectSubmissionManifest {
        schema_version: SCHEMA_VERSION,
        format: FORMAT.to_string(),
        kind: KIND.to_string(),
        generated_by,
        generated_at,
        source_scope: request.source_scope,
        source_disclosure_acknowledged: request.source_disclosure_acknowledged,
        network_used: false,
        upload_performed: false,
        summary: summary.clone(),
        files: records,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("无法编码项目提交包清单：{error}"))?;
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("项目提交包清单超过大小上限".to_string());
    }
    let parent = output_path.parent().expect("validated parent");
    let temporary = parent.join(format!(
        ".{}.tmp-{}",
        output_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("project.ckpkg"),
        uuid::Uuid::new_v4()
    ));
    let write_result = (|| -> Result<String, String> {
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("无法创建项目提交包临时文件：{error}"))?;
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);
        write_entry(&mut writer, MARKER_PATH, MARKER_CONTENT, options)?;
        write_entry(&mut writer, MANIFEST_PATH, &manifest_bytes, options)?;
        for file in &files {
            write_entry(&mut writer, file.path, &file.bytes, options)?;
        }
        let mut file = writer
            .finish()
            .map_err(|error| format!("无法完成项目提交容器：{error}"))?;
        file.flush()
            .map_err(|error| format!("无法刷新项目提交包：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("无法同步项目提交包：{error}"))?;
        drop(file);
        let archive_len = std::fs::metadata(&temporary)
            .map_err(|error| format!("无法复核项目提交包临时文件：{error}"))?
            .len();
        if archive_len == 0 || archive_len > MAX_ARCHIVE_BYTES {
            return Err("生成的项目提交包大小无效".to_string());
        }
        let archive_bytes = read_regular_file_snapshot(&temporary, archive_len)?;
        let package_sha256 = sha256_bytes(&archive_bytes);
        // Prefer an atomic same-directory hard link: it publishes a complete
        // file and fails when another process won the destination name. Some
        // removable filesystems do not support hard links, so retain a
        // create_new fallback that is still strictly no-clobber.
        if std::fs::hard_link(&temporary, &output_path).is_ok() {
            let _ = std::fs::remove_file(&temporary);
        } else {
            let mut destination = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&output_path)
                .map_err(|error| format!("无法以 no-clobber 方式安装项目提交包：{error}"))?;
            let copy_result = (|| -> Result<(), String> {
                destination
                    .write_all(&archive_bytes)
                    .map_err(|error| format!("无法写入最终项目提交包：{error}"))?;
                destination
                    .flush()
                    .map_err(|error| format!("无法刷新最终项目提交包：{error}"))?;
                destination
                    .sync_all()
                    .map_err(|error| format!("无法同步最终项目提交包：{error}"))
            })();
            drop(destination);
            if let Err(error) = copy_result {
                let _ = std::fs::remove_file(&output_path);
                return Err(error);
            }
            let _ = std::fs::remove_file(&temporary);
        }
        Ok(package_sha256)
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    let package_sha256 = write_result?;
    let installed = inspect_package(&output_path)
        .map_err(|error| format!("最终 project.ckpkg 回读门禁失败：{error}"))?;
    let expected_file_name = output_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("project.ckpkg")
        .to_string();
    if installed.package_sha256 != package_sha256
        || installed.package_file_name != expected_file_name
        || installed.source_scope != request.source_scope
        || installed.has_dependency_lock != has_dependency_lock
        || installed.has_build_evidence != has_build_evidence
        || installed.included_files != files.len()
        || installed.summary != summary
    {
        return Err("最终 project.ckpkg 回读身份、载荷组成或验收摘要不一致".to_string());
    }
    Ok(ProjectSubmissionExportResult {
        output_path: output_path.to_string_lossy().to_string(),
        package_file_name: expected_file_name,
        package_sha256,
        schema_version: SCHEMA_VERSION,
        included_files: files.len(),
        source_scope: request.source_scope,
        has_dependency_lock,
        has_build_evidence,
        summary,
        integrity_verified: true,
        publisher_identity_verified: false,
        authenticity_message: "完整性已校验，但该本地容器未包含发布者身份签名。".to_string(),
        network_used: false,
        upload_performed: false,
    })
}

fn safe_archive_path(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value.contains('\\')
        || value.starts_with('/')
        || value.contains('\0')
        || value.contains(':')
    {
        return Err(format!("项目提交包包含不安全路径：{value}"));
    }
    let path = Path::new(value);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("项目提交包包含路径穿越或非标准路径：{value}"));
    }
    Ok(value.to_string())
}

fn reject_non_regular_zip_entry<R: Read>(entry: &zip::read::ZipFile<'_, R>) -> Result<(), String> {
    if entry.is_dir() {
        return Err(format!("项目提交包不允许目录条目：{}", entry.name()));
    }
    if let Some(mode) = entry.unix_mode() {
        let file_type = mode & 0o170000;
        if file_type != 0 && file_type != 0o100000 {
            return Err(format!(
                "项目提交包不允许符号链接或特殊文件：{}",
                entry.name()
            ));
        }
    }
    Ok(())
}

fn input_is_regular_file(path: &Path) -> Result<u64, String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("无法检查项目提交包：{error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("项目提交包路径必须是普通本地文件，不能是符号链接".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("项目提交包路径不能是 Windows 重解析点".to_string());
        }
    }
    if metadata.len() == 0 || metadata.len() > MAX_ARCHIVE_BYTES {
        return Err("项目提交包文件大小无效".to_string());
    }
    Ok(metadata.len())
}

fn read_entry_bounded<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    path: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let entry = archive
        .by_name(path)
        .map_err(|_| format!("项目提交包缺少 {path}"))?;
    reject_non_regular_zip_entry(&entry)?;
    if entry.size() == 0 || entry.size() > max_bytes {
        return Err(format!("项目提交包条目 {path} 大小无效"));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取项目提交包条目 {path}：{error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("项目提交包条目 {path} 解压后超过安全上限"));
    }
    Ok(bytes)
}

fn expected_paths(scope: ProjectSourceScope, has_lock: bool, has_build: bool) -> BTreeSet<String> {
    let mut paths = BTreeSet::from([
        MARKER_PATH.to_string(),
        MANIFEST_PATH.to_string(),
        REPORT_JSON_PATH.to_string(),
        REPORT_HTML_PATH.to_string(),
    ]);
    if scope.includes_workspace() {
        paths.insert(WORKSPACE_PATH.to_string());
    }
    if scope.includes_generated_source() {
        paths.insert(GENERATED_SOURCE_PATH.to_string());
    }
    if has_lock {
        paths.insert(LOCK_PATH.to_string());
    }
    if has_build {
        paths.insert(BUILD_EVIDENCE_PATH.to_string());
    }
    paths
}

pub fn inspect_package(path: &Path) -> Result<ProjectSubmissionInspection, String> {
    let input_len = input_is_regular_file(path)?;
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("ckpkg"))
    {
        return Err("请选择 .ckpkg 项目提交包".to_string());
    }
    let package_file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or("项目提交包文件名无效")?
        .to_string();
    let archive_bytes = read_regular_file_snapshot(path, input_len)?;
    let package_sha256 = sha256_bytes(&archive_bytes);
    let mut archive = ZipArchive::new(Cursor::new(archive_bytes))
        .map_err(|error| format!("项目提交容器结构无效：{error}"))?;
    if archive.len() < 4 || archive.len() > MAX_ENTRIES {
        return Err("项目提交包条目数量无效".to_string());
    }
    let mut names = BTreeSet::new();
    let mut casefold_names = HashSet::new();
    let mut total_uncompressed = 0u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("无法读取项目提交包索引 {index}：{error}"))?;
        if entry.encrypted() {
            return Err(format!("项目提交包不允许加密条目：{}", entry.name()));
        }
        reject_non_regular_zip_entry(&entry)?;
        let name = safe_archive_path(entry.name())?;
        if !names.insert(name.clone()) || !casefold_names.insert(name.to_ascii_lowercase()) {
            return Err(format!("项目提交包包含重复或大小写冲突条目：{name}"));
        }
        let limit = size_limit(&name).ok_or_else(|| format!("项目提交包包含未声明路径：{name}"))?;
        if entry.size() == 0 || entry.size() > limit {
            return Err(format!("项目提交包条目 {name} 大小无效"));
        }
        total_uncompressed = total_uncompressed
            .checked_add(entry.size())
            .ok_or("项目提交包解压后大小溢出")?;
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES {
            return Err("项目提交包解压后超过 32 MiB 安全上限".to_string());
        }
    }
    let marker = read_entry_bounded(&mut archive, MARKER_PATH, MARKER_CONTENT.len() as u64)?;
    if marker != MARKER_CONTENT {
        return Err("文件不是 CK project.ckpkg 独立提交容器".to_string());
    }
    let manifest_bytes = read_entry_bounded(&mut archive, MANIFEST_PATH, MAX_MANIFEST_BYTES)?;
    let manifest: ProjectSubmissionManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("项目提交包清单 schema 无效：{error}"))?;
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "不支持的 project.ckpkg schemaVersion {}",
            manifest.schema_version
        ));
    }
    if manifest.format != FORMAT || manifest.kind != KIND {
        return Err("project.ckpkg 的 format 或 kind 无效".to_string());
    }
    if manifest.generated_by.product != "CK Desktop"
        || manifest.generated_by.component != "project-submission-exporter"
        || manifest.generated_by.version.trim().is_empty()
        || manifest.generated_by.version.chars().count() > 64
    {
        return Err("project.ckpkg 的 generatedBy 标识无效".to_string());
    }
    if !valid_rfc3339(&manifest.generated_at) {
        return Err("project.ckpkg 的 generatedAt 不是有效 RFC3339 时间".to_string());
    }
    if manifest.network_used || manifest.upload_performed {
        return Err(
            "project.ckpkg 声明使用了网络或自动上传，拒绝作为本地只读提交包打开".to_string(),
        );
    }
    if manifest.source_scope != ProjectSourceScope::NoSource
        && !manifest.source_disclosure_acknowledged
    {
        return Err("project.ckpkg 包含源码但缺少明确的信息披露确认".to_string());
    }
    if manifest.source_scope == ProjectSourceScope::NoSource
        && manifest.source_disclosure_acknowledged
    {
        return Err("project.ckpkg 不含源码却声明了源码披露确认".to_string());
    }
    if manifest.files.len() < 2 || manifest.files.len() > 6 {
        return Err("project.ckpkg 清单载荷数量无效".to_string());
    }
    let mut declared = BTreeMap::new();
    for record in &manifest.files {
        let path = safe_archive_path(&record.path)?;
        if [MARKER_PATH, MANIFEST_PATH].contains(&path.as_str()) {
            return Err(format!(
                "project.ckpkg 清单不得把格式元数据作为载荷声明：{path}"
            ));
        }
        if declared.insert(path.clone(), record).is_some() {
            return Err(format!("project.ckpkg 清单重复声明文件：{path}"));
        }
        if !valid_sha256(&record.sha256) || record.size == 0 {
            return Err(format!("project.ckpkg 清单的 size/SHA-256 无效：{path}"));
        }
    }
    let has_lock = declared.contains_key(LOCK_PATH);
    let has_build = declared.contains_key(BUILD_EVIDENCE_PATH);
    let expected = expected_paths(manifest.source_scope, has_lock, has_build);
    if names != expected {
        let extras = names.difference(&expected).cloned().collect::<Vec<_>>();
        let missing = expected.difference(&names).cloned().collect::<Vec<_>>();
        return Err(format!(
            "project.ckpkg 路径集合与 schema 不一致；未声明/多余：{}；缺少：{}",
            extras.join(", "),
            missing.join(", ")
        ));
    }
    if declared.len() + 2 != names.len() {
        return Err("project.ckpkg 包含未声明文件或清单遗漏".to_string());
    }
    let required_roles = [
        (
            REPORT_JSON_PATH,
            ProjectSubmissionFileRole::AcceptanceReport,
        ),
        (REPORT_HTML_PATH, ProjectSubmissionFileRole::PrintableReport),
    ];
    for (path, role) in required_roles {
        if declared
            .get(path)
            .map(|record| (&record.role, record.redacted))
            != Some((&role, true))
        {
            return Err(format!("project.ckpkg 必需文件 {path} 的角色无效"));
        }
    }
    let optional_roles = [
        (
            WORKSPACE_PATH,
            ProjectSubmissionFileRole::EditableProject,
            false,
        ),
        (
            GENERATED_SOURCE_PATH,
            ProjectSubmissionFileRole::GeneratedSource,
            false,
        ),
        (LOCK_PATH, ProjectSubmissionFileRole::DependencyLock, true),
        (
            BUILD_EVIDENCE_PATH,
            ProjectSubmissionFileRole::BuildEvidence,
            true,
        ),
    ];
    for (path, role, redacted) in optional_roles {
        if let Some(record) = declared.get(path) {
            if record.role != role || record.redacted != redacted {
                return Err(format!("project.ckpkg 文件 {path} 的角色无效"));
            }
        }
    }
    let mut payloads = BTreeMap::new();
    for (path, record) in &declared {
        let max = size_limit(path).ok_or_else(|| format!("project.ckpkg 不允许路径 {path}"))?;
        let bytes = read_entry_bounded(&mut archive, path, max)?;
        if bytes.len() as u64 != record.size
            || sha256_bytes(&bytes) != record.sha256.to_ascii_lowercase()
        {
            return Err(format!("project.ckpkg 文件大小或 SHA-256 不匹配：{path}"));
        }
        payloads.insert(path.clone(), bytes);
    }
    let report: Value = serde_json::from_slice(
        payloads
            .get(REPORT_JSON_PATH)
            .ok_or("project.ckpkg 缺少验收 JSON")?,
    )
    .map_err(|error| format!("project.ckpkg 验收 JSON 无效：{error}"))?;
    let expected_summary = summary_from_report(&report)?;
    if expected_summary != manifest.summary {
        return Err("project.ckpkg 摘要与验收报告不一致，可能已被篡改".to_string());
    }
    if let Some(workspace) = payloads.get(WORKSPACE_PATH) {
        let workspace_json: Value = serde_json::from_slice(workspace)
            .map_err(|error| format!("project.ckpkg 可编辑工程 JSON 无效：{error}"))?;
        if !workspace_json.is_object()
            || sha256_bytes(workspace) != expected_summary.workspace_sha256.to_ascii_lowercase()
        {
            return Err("project.ckpkg 可编辑工程与验收报告指纹不一致".to_string());
        }
    }
    if let Some(source) = payloads.get(GENERATED_SOURCE_PATH) {
        std::str::from_utf8(source).map_err(|_| "project.ckpkg 生成源码不是 UTF-8")?;
        if sha256_bytes(source) != expected_summary.generated_code_sha256.to_ascii_lowercase() {
            return Err("project.ckpkg 生成源码与验收报告指纹不一致".to_string());
        }
    }
    if let Some(lock) = payloads.get(LOCK_PATH) {
        if !expected_summary.dependency_lock_available {
            return Err("project.ckpkg 附加了 ck.lock，但验收报告声明依赖锁不可用".to_string());
        }
        validate_sanitized_lock(lock, &expected_summary, &report)?;
    }
    if let Some(evidence) = payloads.get(BUILD_EVIDENCE_PATH) {
        let expected = build_evidence(&report, &expected_summary)?;
        if evidence != &expected {
            return Err("project.ckpkg 构建证据与完整 FQBN、工程指纹或验收摘要不一致".to_string());
        }
    }
    let html_bytes = payloads
        .get(REPORT_HTML_PATH)
        .ok_or("project.ckpkg 缺少可打印 HTML")?;
    let html =
        std::str::from_utf8(html_bytes).map_err(|_| "project.ckpkg 可打印 HTML 不是 UTF-8")?;
    validate_printable_html(html)?;
    let expected_html = printable_html(&report, &expected_summary, &manifest.generated_at)?;
    if html_bytes != &expected_html {
        return Err("project.ckpkg 可打印 HTML 与验收报告不一致，可能已被篡改".to_string());
    }
    Ok(ProjectSubmissionInspection {
        valid: true,
        schema_version: manifest.schema_version,
        format: manifest.format,
        kind: manifest.kind,
        generated_by: manifest.generated_by,
        generated_at: manifest.generated_at,
        package_file_name,
        package_sha256,
        included_files: manifest.files.len(),
        source_scope: manifest.source_scope,
        source_disclosure_acknowledged: manifest.source_disclosure_acknowledged,
        has_dependency_lock: has_lock,
        has_build_evidence: has_build,
        summary: expected_summary,
        integrity_verified: true,
        publisher_identity_verified: false,
        authenticity_message: "完整性已校验，但该本地容器未包含发布者身份签名。".to_string(),
        network_used: false,
        upload_performed: false,
    })
}

#[tauri::command]
pub fn export_project_submission(
    request: ProjectSubmissionExportRequest,
) -> Result<ProjectSubmissionExportResult, String> {
    export_package(request)
}

#[tauri::command]
pub fn inspect_project_submission(path: String) -> Result<ProjectSubmissionInspection, String> {
    inspect_package(Path::new(path.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ck-project-submission-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("temp root");
        root
    }

    fn workspace() -> String {
        r#"{"blocks":{"languageVersion":0,"blocks":[]}}"#.to_string()
    }

    fn source() -> String {
        "void setup() {}\nvoid loop() {}\n".to_string()
    }

    fn report(workspace: &str, source: &str) -> Value {
        json!({
            "schemaVersion": 1,
            "kind": "ck-project-acceptance-report",
            "generatedAt": "2026-07-16T00:00:00Z",
            "project": {
                "name": "C6 温度项目",
                "blockCount": 3,
                "workspaceSha256": sha256_bytes(workspace.as_bytes()),
                "generatedCodeSha256": sha256_bytes(source.as_bytes()),
                "structure": { "available": true, "topLevelFlowCount": 1, "blockTypes": [] },
                "pathIncluded": false,
            },
            "target": {
                "boardName": "ESP32-C6",
                "boardId": "esp32c6",
                "boardPackageId": "builtin-esp32c6",
                "fqbn": "esp32:esp32:esp32c6:FlashSize=16M",
                "coreId": "esp32:esp32",
                "coreVersion": "3.3.6",
            },
            "build": {
                "state": "passed", "recordedAt": "2026-07-16T00:00:00Z",
                "profile": "quick-fast", "durationMs": 1000, "warningCount": 0,
                "flashUsedBytes": 100, "flashTotalBytes": 1000,
                "ramUsedBytes": 20, "ramTotalBytes": 200,
                "resourceGrowth": {
                    "status": "no-baseline", "flashDeltaBytes": null, "ramDeltaBytes": null,
                    "summary": "无基线", "detail": "", "contributions": [], "evidenceKind": null,
                },
            },
            "dependencies": { "lockAvailable": false, "lockSha256": null, "entries": [], "allVersioned": false },
            "hardware": {
                "state": "verified", "observedAt": "2026-07-16T00:00:00Z", "chip": "ESP32-C6",
                "revision": "v0.1", "flashBytes": 16777216, "psramBytes": null, "identityIncluded": false,
            },
            "history": {
                "checkpointCount": 2, "latestCheckpointAt": "2026-07-16T00:30:00Z",
                "modificationCount": null, "note": "CK 1.0 未启用逐操作审计历史",
            },
            "notes": { "circuitDescription": null, "testRecords": null },
            "health": {
                "checks": [],
                "counts": { "pass": 0, "warning": 0, "error": 0, "info": 0 },
                "summary": "当前检查项未发现确定问题",
            },
            "limitations": [],
        })
    }

    fn request(output: &Path, scope: ProjectSourceScope) -> ProjectSubmissionExportRequest {
        let workspace = workspace();
        let source = source();
        ProjectSubmissionExportRequest {
            output_path: output.to_string_lossy().to_string(),
            source_scope: scope,
            source_disclosure_acknowledged: scope != ProjectSourceScope::NoSource,
            report: report(&workspace, &source),
            workspace_json: scope.includes_workspace().then_some(workspace),
            generated_source: scope.includes_generated_source().then_some(source),
            ck_lock: None,
            include_build_evidence: true,
        }
    }

    fn locked_request(output: &Path, content_sha256: &str) -> ProjectSubmissionExportRequest {
        let mut request = request(output, ProjectSourceScope::NoSource);
        let lock = serde_json::to_string_pretty(&json!({
            "schemaVersion": 1,
            "createdAt": "2026-07-16T00:00:00Z",
            "fqbn": "esp32:esp32:esp32c6:FlashSize=16M",
            "boardPackageId": "builtin-esp32c6",
            "core": { "id": "esp32:esp32", "version": "3.3.6" },
            "dependencies": [{
                "name": "SensorLib",
                "version": "1.2.3",
                "contentSha256": content_sha256,
                "fileCount": 4,
                "totalBytes": 1200,
                "sourcePath": "C:\\Users\\student\\SecretLibrary",
                "snapshotPath": "C:\\Users\\student\\snapshot",
            }],
        }))
        .unwrap();
        request.report["dependencies"] = json!({
            "lockAvailable": true,
            "lockSha256": sha256_bytes(lock.as_bytes()),
            "entries": [{
                "name": "SensorLib",
                "version": "1.2.3",
                "contentSha256": content_sha256,
            }],
            "allVersioned": true,
        });
        request.ck_lock = Some(lock);
        request
    }

    fn rewrite_zip(
        source: &Path,
        destination: &Path,
        mutate: impl Fn(&str, Vec<u8>) -> Option<(String, Vec<u8>)>,
    ) {
        let input = File::open(source).expect("source archive");
        let mut archive = ZipArchive::new(input).expect("archive");
        let output = File::create(destination).expect("destination");
        let mut writer = ZipWriter::new(output);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).expect("entry");
            let name = entry.name().to_string();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).expect("read entry");
            if let Some((next_name, next_bytes)) = mutate(&name, bytes) {
                writer.start_file(next_name, options).expect("start file");
                writer.write_all(&next_bytes).expect("write file");
            }
        }
        writer.finish().expect("finish");
    }

    #[test]
    fn exports_and_inspects_all_explicit_source_scopes_without_extracting() {
        let root = temp_root("scopes");
        for (index, scope) in [
            ProjectSourceScope::NoSource,
            ProjectSourceScope::EditableProject,
            ProjectSourceScope::GeneratedSource,
            ProjectSourceScope::EditableAndGenerated,
        ]
        .into_iter()
        .enumerate()
        {
            let output = root.join(format!("scope-{index}.ckpkg"));
            let exported = export_package(request(&output, scope)).expect("export");
            assert!(!exported.publisher_identity_verified);
            assert_eq!(exported.package_file_name, format!("scope-{index}.ckpkg"));
            assert_eq!(
                exported.package_sha256,
                sha256_bytes(&std::fs::read(&output).expect("package bytes"))
            );
            let inspected = inspect_package(&output).expect("inspect");
            assert_eq!(inspected.source_scope, scope);
            assert!(inspected.integrity_verified);
            assert!(!inspected.publisher_identity_verified);
            assert!(!inspected.network_used);
            assert!(!inspected.upload_performed);
            assert_eq!(inspected.package_sha256, exported.package_sha256);
            assert_eq!(inspected.package_file_name, exported.package_file_name);
            assert_eq!(inspected.has_build_evidence, exported.has_build_evidence);
            assert_eq!(inspected.has_dependency_lock, exported.has_dependency_lock);
            assert_eq!(inspected.summary.fqbn, "esp32:esp32:esp32c6:FlashSize=16M");
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn source_requires_acknowledgement_and_exact_current_hashes() {
        let root = temp_root("source-gates");
        let output = root.join("submission.ckpkg");
        let mut missing_ack = request(&output, ProjectSourceScope::EditableProject);
        missing_ack.source_disclosure_acknowledged = false;
        assert!(export_package(missing_ack).unwrap_err().contains("确认"));

        let mut stale = request(&output, ProjectSourceScope::GeneratedSource);
        stale.generated_source = Some("changed".to_string());
        assert!(export_package(stale).unwrap_err().contains("SHA-256"));
        let mut forged_ack = request(&output, ProjectSourceScope::NoSource);
        forged_ack.source_disclosure_acknowledged = true;
        assert!(export_package(forged_ack).unwrap_err().contains("不得伪造"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ck_lock_requires_exact_raw_hash_and_dependency_contract_then_redacts_paths() {
        let root = temp_root("lock");
        let output = root.join("locked.ckpkg");
        let request = locked_request(&output, &"c".repeat(64));
        export_package(request).expect("locked export");
        let inspected = inspect_package(&output).expect("locked inspect");
        assert!(inspected.summary.dependency_lock_available);
        assert_eq!(inspected.summary.dependency_count, 1);
        let file = File::open(&output).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let mut lock = String::new();
        archive
            .by_name(LOCK_PATH)
            .unwrap()
            .read_to_string(&mut lock)
            .unwrap();
        assert!(!lock.contains("\"sourcePath\":"));
        assert!(!lock.contains("\"snapshotPath\":"));
        assert!(!lock.contains("C:\\Users"));

        let stale_output = root.join("stale.ckpkg");
        let mut stale = locked_request(&stale_output, &"d".repeat(64));
        let expected_report = stale.report.clone();
        stale.ck_lock = locked_request(&stale_output, &"e".repeat(64)).ck_lock;
        stale.report = expected_report;
        assert!(export_package(stale).unwrap_err().contains("原始 SHA-256"));

        let mismatched_output = root.join("mismatched.ckpkg");
        let mut mismatched = locked_request(&mismatched_output, &"f".repeat(64));
        mismatched.report["dependencies"]["entries"][0]["name"] = json!("OtherLib");
        assert!(export_package(mismatched).unwrap_err().contains("依赖条目"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn printable_html_is_backend_generated_detailed_and_rejects_active_content() {
        let workspace = workspace();
        let source = source();
        let mut report = report(&workspace, &source);
        report["project"]["structure"]["blockTypes"] = json!([{ "type": "oled_text", "count": 2 }]);
        report["notes"] = json!({
            "circuitDescription": "SDA 接 GPIO 6 <安全>",
            "testRecords": "测试 100 次\n全部通过",
        });
        report["health"] = json!({
            "checks": [{
                "id": "board-passport", "state": "pass", "title": "板卡护照", "detail": "完整 FQBN 已匹配", "evidence": "esp32:esp32",
                "stages": [{ "id": "device", "state": "pass", "title": "真板验证", "detail": "ESP32-C6", "checkedAt": "2026-07-16T00:00:00Z" }],
            }],
            "counts": { "pass": 1, "warning": 0, "error": 0, "info": 0 },
            "summary": "当前检查项未发现确定问题",
        });
        let summary = summary_from_report(&report).unwrap();
        let html =
            String::from_utf8(printable_html(&report, &summary, "2026-07-16T01:00:00Z").unwrap())
                .unwrap();
        assert!(html.contains("软件结构"));
        assert!(html.contains("oled_text"));
        assert!(html.contains("电路说明与测试记录"));
        assert!(html.contains("板卡护照"));
        assert!(html.contains("真板验证"));
        assert!(html.contains("&lt;安全&gt;"));
        assert!(!html.contains("<script"));
        assert!(
            validate_printable_html("<!doctype html><p>参考纯文本 https://docs.example/device</p>")
                .is_ok()
        );
        for active in [
            "<!doctype html><img src=x onerror=alert(1)>",
            "<!doctype html><meta http-equiv=refresh content='0;url=https://evil'>",
            "<!doctype html><style>body{background:url(data:text/html,x)}</style>",
            "<!doctype html><form action=file:///secret></form>",
            "<!doctype html><a href=https://evil.example>link</a>",
        ] {
            assert!(validate_printable_html(active).is_err());
        }
    }

    #[test]
    fn acceptance_report_rejects_hidden_fields_and_relational_lies() {
        let root = temp_root("report-contract");
        let output = root.join("submission.ckpkg");

        let mut hidden = request(&output, ProjectSourceScope::NoSource);
        hidden.report["build"]["secret"] = json!("C:\\Users\\student\\private.txt");
        assert!(export_package(hidden).unwrap_err().contains("固定 schema"));

        let mut false_counts = request(&output, ProjectSourceScope::NoSource);
        false_counts.report["health"] = json!({
            "checks": [{
                "id": "compile-result", "state": "warning", "title": "警告",
                "detail": "缺少证据", "evidence": null,
            }],
            "counts": { "pass": 1, "warning": 0, "error": 0, "info": 0 },
            "summary": "当前检查项未发现确定问题",
        });
        assert!(
            export_package(false_counts)
                .unwrap_err()
                .contains("每个检查项状态")
        );

        let mut false_versioning = locked_request(&output, &"c".repeat(64));
        false_versioning.report["dependencies"]["entries"][0]["version"] = Value::Null;
        false_versioning.report["dependencies"]["allVersioned"] = json!(true);
        assert!(
            export_package(false_versioning)
                .unwrap_err()
                .contains("allVersioned")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_tampered_payload_unknown_path_and_traversal() {
        let root = temp_root("tamper");
        let good = root.join("good.ckpkg");
        export_package(request(&good, ProjectSourceScope::NoSource)).expect("export");

        let tampered = root.join("tampered.ckpkg");
        rewrite_zip(&good, &tampered, |name, mut bytes| {
            if name == REPORT_JSON_PATH {
                bytes.extend_from_slice(b" ");
            }
            Some((name.to_string(), bytes))
        });
        assert!(inspect_package(&tampered).unwrap_err().contains("SHA-256"));

        let unknown = root.join("unknown.ckpkg");
        rewrite_zip(&good, &unknown, |name, bytes| {
            Some((name.to_string(), bytes))
        });
        {
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&unknown)
                .unwrap();
            let mut writer = ZipWriter::new_append(file).unwrap();
            writer
                .start_file("unexpected.txt", SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"unexpected").unwrap();
            writer.finish().unwrap();
        }
        assert!(
            inspect_package(&unknown)
                .unwrap_err()
                .contains("未声明路径")
        );

        let duplicate = root.join("duplicate.ckpkg");
        std::fs::copy(&good, &duplicate).unwrap();
        {
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&duplicate)
                .unwrap();
            let mut writer = ZipWriter::new_append(file).unwrap();
            writer
                .start_file(
                    "REPORT/PROJECT-ACCEPTANCE.JSON",
                    SimpleFileOptions::default(),
                )
                .unwrap();
            writer.write_all(b"{}").unwrap();
            writer.finish().unwrap();
        }
        assert!(inspect_package(&duplicate).unwrap_err().contains("重复"));

        let traversal = root.join("traversal.ckpkg");
        let file = File::create(&traversal).unwrap();
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("../escape", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"x").unwrap();
        writer.finish().unwrap();
        let traversal_error = inspect_package(&traversal).unwrap_err();
        assert!(traversal_error.contains("条目数量") || traversal_error.contains("不安全"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn unknown_schema_and_summary_mismatch_fail_closed() {
        let root = temp_root("schema");
        let good = root.join("good.ckpkg");
        export_package(request(&good, ProjectSourceScope::NoSource)).expect("export");
        let bad_schema = root.join("bad-schema.ckpkg");
        rewrite_zip(&good, &bad_schema, |name, bytes| {
            if name != MANIFEST_PATH {
                return Some((name.to_string(), bytes));
            }
            let mut manifest: Value = serde_json::from_slice(&bytes).unwrap();
            manifest["schemaVersion"] = json!(99);
            Some((
                name.to_string(),
                serde_json::to_vec_pretty(&manifest).unwrap(),
            ))
        });
        assert!(
            inspect_package(&bad_schema)
                .unwrap_err()
                .contains("schemaVersion")
        );

        let bad_summary = root.join("bad-summary.ckpkg");
        rewrite_zip(&good, &bad_summary, |name, bytes| {
            if name != MANIFEST_PATH {
                return Some((name.to_string(), bytes));
            }
            let mut manifest: Value = serde_json::from_slice(&bytes).unwrap();
            manifest["summary"]["projectName"] = json!("篡改摘要");
            Some((
                name.to_string(),
                serde_json::to_vec_pretty(&manifest).unwrap(),
            ))
        });
        assert!(inspect_package(&bad_summary).unwrap_err().contains("摘要"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn manifest_runtime_matches_schema_for_dates_hash_case_scope_and_size() {
        let root = temp_root("manifest-parity");
        let good = root.join("good.ckpkg");
        export_package(request(&good, ProjectSourceScope::NoSource)).expect("export");
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../../docs/schemas/ck-project-package-parity-corpus.json"
        ))
        .expect("shared parity corpus");
        assert_eq!(corpus["schemaVersion"], 1);
        for case in corpus["cases"].as_array().expect("parity cases") {
            let case_id = case["id"].as_str().expect("case id");
            assert_eq!(case["expected"], "reject");
            let destination = root.join(format!("{case_id}.ckpkg"));
            rewrite_zip(&good, &destination, |name, bytes| {
                if name != MANIFEST_PATH {
                    return Some((name.to_string(), bytes));
                }
                let mut manifest: Value = serde_json::from_slice(&bytes).unwrap();
                match case_id {
                    "invalid-generated-at" => manifest["generatedAt"] = json!("not-a-date"),
                    "uppercase-payload-sha256" => {
                        manifest["files"][0]["sha256"] = json!("A".repeat(64));
                    }
                    "no-source-forged-disclosure" => {
                        manifest["sourceDisclosureAcknowledged"] = json!(true);
                    }
                    "oversized-acceptance-report-record" => {
                        let files = manifest["files"].as_array_mut().unwrap();
                        let report = files
                            .iter_mut()
                            .find(|item| item["path"] == REPORT_JSON_PATH)
                            .unwrap();
                        report["size"] = json!(MAX_REPORT_BYTES + 1);
                    }
                    "editable-scope-missing-workspace" => {
                        manifest["sourceScope"] = json!("editable_project");
                        manifest["sourceDisclosureAcknowledged"] = json!(true);
                    }
                    unknown => panic!("unknown shared parity mutation: {unknown}"),
                }
                Some((
                    name.to_string(),
                    serde_json::to_vec_pretty(&manifest).unwrap(),
                ))
            });
            assert!(
                inspect_package(&destination).is_err(),
                "Rust unexpectedly accepted shared parity case {case_id}"
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn input_symlink_is_rejected() {
        let root = temp_root("symlink");
        let good = root.join("good.ckpkg");
        export_package(request(&good, ProjectSourceScope::NoSource)).expect("export");
        #[cfg(unix)]
        {
            let link = root.join("link.ckpkg");
            std::os::unix::fs::symlink(&good, &link).unwrap();
            assert!(inspect_package(&link).unwrap_err().contains("符号链接"));
        }
        #[cfg(windows)]
        {
            let link = root.join("link.ckpkg");
            if std::os::windows::fs::symlink_file(&good, &link).is_ok() {
                assert!(inspect_package(&link).unwrap_err().contains("符号链接"));
            }
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
