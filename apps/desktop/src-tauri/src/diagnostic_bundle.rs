use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const DIAGNOSTIC_SCHEMA_VERSION: u32 = 1;
const MANIFEST_NAME: &str = "diagnostic-manifest.json";
const SUMMARY_NAME: &str = "summary.zh-CN.json";
const MAX_DECLARED_ITEMS: usize = 256;
const MAX_ARCHIVE_FILES: usize = 4096;
const MAX_SINGLE_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticContentLevel {
    FullProject,
    GeneratedSourceOnly,
    NoSource,
}

impl DiagnosticContentLevel {
    fn includes(self, role: DiagnosticItemRole) -> bool {
        match self {
            Self::FullProject => true,
            Self::GeneratedSourceOnly => role != DiagnosticItemRole::Project,
            Self::NoSource => !role.carries_source(),
        }
    }

    fn chinese_label(self) -> &'static str {
        match self {
            Self::FullProject => "完整工程",
            Self::GeneratedSourceOnly => "仅生成源码",
            Self::NoSource => "不含源码",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticItemRole {
    Project,
    GeneratedSource,
    SourceMap,
    CompileLog,
    UploadLog,
    SerialLog,
    ArtifactManifest,
    BoardManifest,
    Environment,
    Other,
}

impl DiagnosticItemRole {
    fn carries_source(self) -> bool {
        matches!(
            self,
            Self::Project | Self::GeneratedSource | Self::SourceMap
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticPrivacyOptions {
    #[serde(default = "default_true")]
    pub redact_wifi: bool,
    #[serde(default = "default_true")]
    pub redact_username: bool,
    #[serde(default = "default_true")]
    pub redact_paths: bool,
    #[serde(default = "default_true")]
    pub redact_serial_content: bool,
}

impl Default for DiagnosticPrivacyOptions {
    fn default() -> Self {
        Self {
            redact_wifi: true,
            redact_username: true,
            redact_paths: true,
            redact_serial_content: true,
        }
    }
}

impl DiagnosticPrivacyOptions {
    fn requires_text_redaction(&self) -> bool {
        self.redact_wifi || self.redact_username || self.redact_paths
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticContext {
    #[serde(default)]
    pub board_name: Option<String>,
    #[serde(default)]
    pub board_id: Option<String>,
    #[serde(default)]
    pub core_package: Option<String>,
    #[serde(default)]
    pub core_version: Option<String>,
    #[serde(default)]
    pub fqbn: Option<String>,
    #[serde(default)]
    pub flash_used_bytes: Option<u64>,
    #[serde(default)]
    pub flash_total_bytes: Option<u64>,
    #[serde(default)]
    pub flash_configuration: Option<String>,
    #[serde(default)]
    pub core_missing: bool,
    #[serde(default)]
    pub failure_stage: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticBundleItem {
    pub id: String,
    pub role: DiagnosticItemRole,
    pub archive_path: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticBundleExportRequest {
    pub output_path: String,
    pub content_level: DiagnosticContentLevel,
    #[serde(default)]
    pub privacy: DiagnosticPrivacyOptions,
    #[serde(default)]
    pub context: DiagnosticContext,
    #[serde(default)]
    pub items: Vec<DiagnosticBundleItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticSummaryZh {
    pub title: String,
    pub content_level: String,
    pub board: String,
    pub core: String,
    pub fqbn: String,
    pub flash: String,
    pub missing_core: bool,
    pub failure_stage: String,
    pub source_included: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticBundleFileRecord {
    pub item_id: String,
    pub role: DiagnosticItemRole,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default)]
    pub redacted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticBundleManifest {
    schema_version: u32,
    generated_by: String,
    generated_at: String,
    content_level: DiagnosticContentLevel,
    privacy: DiagnosticPrivacyOptions,
    context: DiagnosticContext,
    summary: DiagnosticSummaryZh,
    files: Vec<DiagnosticBundleFileRecord>,
    warnings: Vec<String>,
    network_used: bool,
    upload_performed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticBundleExportResult {
    pub output_path: String,
    pub included_files: usize,
    pub missing_items: usize,
    pub omitted_items: usize,
    pub warnings: Vec<String>,
    pub summary: DiagnosticSummaryZh,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticBundleInspection {
    pub valid: bool,
    pub schema_version: u32,
    pub included_files: usize,
    pub missing_items: usize,
    pub warnings: Vec<String>,
    pub summary: DiagnosticSummaryZh,
    pub network_used: bool,
    pub upload_performed: bool,
}

#[derive(Debug, Clone)]
enum PreparedSource {
    File(PathBuf),
    Inline(Vec<u8>),
}

#[derive(Debug, Clone)]
struct PreparedFile {
    item_id: String,
    role: DiagnosticItemRole,
    archive_path: String,
    source_path: Option<PathBuf>,
    source: PreparedSource,
}

fn safe_archive_path(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() || normalized.len() > 512 || normalized.contains('\0') {
        return Err(format!("诊断包内路径无效：'{raw}'"));
    }
    let path = Path::new(&normalized);
    for component in path.components() {
        match component {
            Component::Normal(value) if !value.is_empty() => {}
            _ => return Err(format!("诊断包内路径不安全：'{raw}'")),
        }
    }
    Ok(path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/"))
}

fn payload_archive_path(raw: &str) -> Result<String, String> {
    Ok(format!("files/{}", safe_archive_path(raw)?))
}

fn hash_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn source_path_for_manifest(path: &Path, privacy: &DiagnosticPrivacyOptions) -> Option<String> {
    if privacy.redact_paths {
        return None;
    }
    let raw = path.to_string_lossy().to_string();
    let output = if privacy.redact_username {
        redact_username(&raw)
    } else {
        raw
    };
    Some(redact_mac(&output))
}

fn redact_username(input: &str) -> String {
    let mut output = input.to_string();
    for value in [std::env::var("USERNAME").ok(), std::env::var("USER").ok()]
        .into_iter()
        .flatten()
        .filter(|value| !value.trim().is_empty())
    {
        if let Ok(pattern) = Regex::new(&format!(
            r"(?i)(^|[\\/]){}([\\/]|$)",
            regex::escape(value.trim())
        )) {
            output = pattern
                .replace_all(&output, "${1}<用户名>${2}")
                .into_owned();
        }
    }
    output
}

fn redact_paths(input: &str) -> String {
    let windows =
        Regex::new(r#"(?i)(?:[a-z]:[\\/]|\\\\)[^\s\"'<>|]+"#).expect("windows path regex");
    let unix_home = Regex::new(r#"/(?:Users|home)/[^\s\"']+"#).expect("unix path regex");
    let output = windows.replace_all(input, "<本机路径>");
    unix_home.replace_all(&output, "<本机路径>").into_owned()
}

fn redact_wifi(input: &str) -> String {
    let wifi_begin =
        Regex::new(r#"(?i)(WiFi\.begin\s*\(\s*)(\"[^\"]*\"|'[^']*')(\s*,\s*)(\"[^\"]*\"|'[^']*')"#)
            .expect("WiFi.begin regex");
    let assignments =
        Regex::new(r#"(?im)^(\s*(?:wifi[._-]?)?(?:ssid|password|passphrase)\s*[:=]\s*).+$"#)
            .expect("Wi-Fi assignment regex");
    let constants = Regex::new(r#"(?i)((?:WIFI_)?(?:SSID|PASSWORD)\s*=\s*)(\"[^\"]*\"|'[^']*')"#)
        .expect("Wi-Fi constant regex");
    let output = wifi_begin.replace_all(input, r#"${1}"<已隐去SSID>"${3}"<已隐去密码>""#);
    let output = assignments.replace_all(&output, "${1}<已隐去Wi-Fi信息>");
    constants
        .replace_all(&output, "${1}\"<已隐去Wi-Fi信息>\"")
        .into_owned()
}

/// MAC addresses are stable device identifiers, so diagnostic bundles never export them in full.
/// This protection is intentionally independent from the user-selectable privacy switches.
fn redact_mac(input: &str) -> String {
    const REDACTED: &str = "[MAC已隐藏]";
    let separated = Regex::new(r"(?i)(^|[^0-9a-f])(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}([^0-9a-f]|$)")
        .expect("colon/dash MAC regex");
    let dotted = Regex::new(r"(?i)(^|[^0-9a-f])(?:[0-9a-f]{4}\.){2}[0-9a-f]{4}([^0-9a-f]|$)")
        .expect("dotted MAC regex");
    let keyed_compact = Regex::new(
        r#"(?ix)
        (
            "?
            (?:
                base[\s_.-]*mac |
                device[\s_.-]*mac |
                bluetooth[\s_.-]*mac |
                bt[\s_.-]*mac |
                wifi[\s_.-]*mac |
                mac(?:[\s_.-]*address)?
            )
            "?
            \s*[:=]\s*["']?
        )
        [0-9a-f]{12}
        ([^0-9a-f]|$)
        "#,
    )
    .expect("keyed compact MAC regex");

    let output = separated.replace_all(input, format!("${{1}}{REDACTED}${{2}}"));
    let output = dotted.replace_all(&output, format!("${{1}}{REDACTED}${{2}}"));
    keyed_compact
        .replace_all(&output, format!("${{1}}{REDACTED}${{2}}"))
        .into_owned()
}

fn redact_text(input: &str, privacy: &DiagnosticPrivacyOptions) -> String {
    let mut output = redact_mac(input);
    if privacy.redact_wifi {
        output = redact_wifi(&output);
    }
    if privacy.redact_username {
        output = redact_username(&output);
    }
    if privacy.redact_paths {
        output = redact_paths(&output);
    }
    output
}

fn sanitize_context(
    mut context: DiagnosticContext,
    privacy: &DiagnosticPrivacyOptions,
) -> DiagnosticContext {
    for field in [
        &mut context.board_name,
        &mut context.board_id,
        &mut context.core_package,
        &mut context.core_version,
        &mut context.fqbn,
        &mut context.flash_configuration,
        &mut context.failure_stage,
    ] {
        if let Some(value) = field {
            *value = redact_text(value, privacy);
        }
    }
    context
}

fn failure_stage_zh(stage: Option<&str>) -> String {
    match stage
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "" | "none" => "未记录失败".to_string(),
        "environment" | "core" => "环境或核心检查".to_string(),
        "compile" | "build" => "编译".to_string(),
        "link" => "链接".to_string(),
        "upload" | "flash" => "上传/烧录".to_string(),
        "serial" | "runtime" => "串口/运行时".to_string(),
        other => format!("其他阶段：{other}"),
    }
}

fn flash_summary(context: &DiagnosticContext) -> String {
    match (context.flash_used_bytes, context.flash_total_bytes) {
        (Some(used), Some(total)) if total > 0 => {
            format!(
                "{used} / {total} 字节（{:.1}%）",
                used as f64 * 100.0 / total as f64
            )
        }
        (Some(used), _) => format!("已用 {used} 字节"),
        (_, Some(total)) => format!("容量 {total} 字节"),
        _ => context
            .flash_configuration
            .clone()
            .unwrap_or_else(|| "未提供".to_string()),
    }
}

fn build_summary(
    level: DiagnosticContentLevel,
    context: &DiagnosticContext,
    source_included: bool,
) -> DiagnosticSummaryZh {
    let board = context
        .board_name
        .clone()
        .or_else(|| context.board_id.clone())
        .unwrap_or_else(|| "未提供".to_string());
    let missing_core = context.core_missing || context.core_version.is_none();
    let core = if missing_core {
        match context.core_package.as_deref() {
            Some(package) => format!("缺失（{package}）"),
            None => "缺失或未提供".to_string(),
        }
    } else {
        match (
            context.core_package.as_deref(),
            context.core_version.as_deref(),
        ) {
            (Some(package), Some(version)) => format!("{package}@{version}"),
            (_, Some(version)) => version.to_string(),
            _ => "未提供".to_string(),
        }
    };
    DiagnosticSummaryZh {
        title: "CK 本地诊断包".to_string(),
        content_level: level.chinese_label().to_string(),
        board,
        core,
        fqbn: context.fqbn.clone().unwrap_or_else(|| "未提供".to_string()),
        flash: flash_summary(context),
        missing_core,
        failure_stage: failure_stage_zh(context.failure_stage.as_deref()),
        source_included,
    }
}

fn omitted_record(
    item: &DiagnosticBundleItem,
    status: &str,
    note: impl Into<String>,
    privacy: &DiagnosticPrivacyOptions,
) -> DiagnosticBundleFileRecord {
    let note = note.into();
    DiagnosticBundleFileRecord {
        item_id: redact_mac(&item.id),
        role: item.role,
        status: status.to_string(),
        archive_path: safe_archive_path(&redact_mac(&item.archive_path)).ok(),
        source_path: item
            .path
            .as_deref()
            .map(Path::new)
            .and_then(|path| source_path_for_manifest(path, privacy)),
        size: None,
        sha256: None,
        redacted: false,
        note: Some(redact_mac(&note)),
    }
}

fn plan_export(
    request: &DiagnosticBundleExportRequest,
) -> Result<
    (
        Vec<PreparedFile>,
        Vec<DiagnosticBundleFileRecord>,
        Vec<String>,
    ),
    String,
> {
    if request.items.len() > MAX_DECLARED_ITEMS {
        return Err(format!(
            "诊断包清单项目过多：{}（上限 {}）",
            request.items.len(),
            MAX_DECLARED_ITEMS
        ));
    }
    let mut prepared = Vec::new();
    let mut records = Vec::new();
    let mut warnings = Vec::new();
    let mut archive_paths = HashSet::new();

    for item in &request.items {
        if item.id.trim().is_empty() {
            return Err("诊断包清单包含空项目 ID".to_string());
        }
        let sanitized_item_id = redact_mac(&item.id);
        let base_archive = payload_archive_path(&redact_mac(&item.archive_path))?;
        if !request.content_level.includes(item.role) {
            records.push(omitted_record(
                item,
                "omitted_by_level",
                "已按内容档位排除",
                &request.privacy,
            ));
            continue;
        }
        if item.role == DiagnosticItemRole::SerialLog && request.privacy.redact_serial_content {
            records.push(omitted_record(
                item,
                "omitted_serial_content",
                "已按隐私设置排除串口内容",
                &request.privacy,
            ));
            continue;
        }
        if item.path.is_some() && item.content.is_some() {
            return Err(format!(
                "诊断包项目 '{}' 不能同时提供 path 和 content",
                item.id
            ));
        }
        if let Some(content) = item.content.as_ref() {
            if content.len() as u64 > MAX_SINGLE_FILE_BYTES {
                return Err(format!("诊断包项目 '{}' 的内联内容过大", item.id));
            }
            if !archive_paths.insert(base_archive.clone()) {
                return Err(format!("诊断包内路径重复：{base_archive}"));
            }
            prepared.push(PreparedFile {
                item_id: sanitized_item_id.clone(),
                role: item.role,
                archive_path: base_archive,
                source_path: None,
                source: PreparedSource::Inline(content.as_bytes().to_vec()),
            });
            continue;
        }

        let Some(raw_path) = item.path.as_deref() else {
            let message = format!("清单项目 '{}' 未提供本地文件或内容", item.id);
            if item.required {
                warnings.push(message.clone());
            }
            records.push(omitted_record(item, "missing", message, &request.privacy));
            continue;
        };
        let path = PathBuf::from(raw_path);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let message = format!("清单项目 '{}' 的本地文件不存在", item.id);
                if item.required {
                    warnings.push(message.clone());
                }
                records.push(omitted_record(item, "missing", message, &request.privacy));
                continue;
            }
            Err(error) => {
                return Err(format!("无法检查诊断包项目 '{}'：{error}", item.id));
            }
        };
        if metadata.file_type().is_symlink() {
            records.push(omitted_record(
                item,
                "omitted_unsafe_path",
                "符号链接或重解析点未打包",
                &request.privacy,
            ));
            warnings.push(format!("项目 '{}' 因符号链接被排除", item.id));
            continue;
        }
        if metadata.is_file() {
            if metadata.len() > MAX_SINGLE_FILE_BYTES {
                records.push(omitted_record(
                    item,
                    "omitted_too_large",
                    "文件超过单文件大小上限",
                    &request.privacy,
                ));
                warnings.push(format!("项目 '{}' 文件过大，未打包", item.id));
                continue;
            }
            if !archive_paths.insert(base_archive.clone()) {
                return Err(format!("诊断包内路径重复：{base_archive}"));
            }
            prepared.push(PreparedFile {
                item_id: sanitized_item_id.clone(),
                role: item.role,
                archive_path: base_archive,
                source_path: Some(path.clone()),
                source: PreparedSource::File(path),
            });
            continue;
        }
        if !metadata.is_dir() {
            records.push(omitted_record(
                item,
                "omitted_unsupported_type",
                "不是普通文件或目录",
                &request.privacy,
            ));
            continue;
        }

        let mut directory_files = 0usize;
        for entry in WalkDir::new(&path).follow_links(false) {
            let entry =
                entry.map_err(|error| format!("读取诊断包目录项目 '{}' 失败：{error}", item.id))?;
            if entry.path() == path {
                continue;
            }
            let entry_metadata = std::fs::symlink_metadata(entry.path()).map_err(|error| {
                format!("检查诊断包目录文件失败 {}：{error}", entry.path().display())
            })?;
            if entry_metadata.file_type().is_symlink() {
                warnings.push(format!("已排除目录内符号链接：{}", entry.path().display()));
                continue;
            }
            if !entry_metadata.is_file() {
                continue;
            }
            if entry_metadata.len() > MAX_SINGLE_FILE_BYTES {
                warnings.push(format!("已排除过大文件：{}", entry.path().display()));
                records.push(DiagnosticBundleFileRecord {
                    item_id: sanitized_item_id.clone(),
                    role: item.role,
                    status: "omitted_too_large".to_string(),
                    archive_path: None,
                    source_path: source_path_for_manifest(entry.path(), &request.privacy),
                    size: None,
                    sha256: None,
                    redacted: false,
                    note: Some("文件超过单文件大小上限".to_string()),
                });
                continue;
            }
            let relative = entry.path().strip_prefix(&path).map_err(|error| {
                format!("无法计算诊断包相对路径 {}：{error}", entry.path().display())
            })?;
            let relative = safe_archive_path(&redact_mac(&relative.to_string_lossy()))?;
            let archive_path = format!("{base_archive}/{relative}");
            if !archive_paths.insert(archive_path.clone()) {
                return Err(format!("诊断包内路径重复：{archive_path}"));
            }
            directory_files += 1;
            prepared.push(PreparedFile {
                item_id: sanitized_item_id.clone(),
                role: item.role,
                archive_path,
                source_path: Some(entry.path().to_path_buf()),
                source: PreparedSource::File(entry.path().to_path_buf()),
            });
            if prepared.len() > MAX_ARCHIVE_FILES {
                return Err(format!("诊断包文件数量超过上限 {MAX_ARCHIVE_FILES}"));
            }
        }
        if directory_files == 0 {
            records.push(omitted_record(
                item,
                "empty_directory",
                "目录中没有可打包的普通文件",
                &request.privacy,
            ));
        }
    }
    let warnings = warnings
        .into_iter()
        .map(|warning| redact_mac(&warning))
        .collect();
    Ok((prepared, records, warnings))
}

fn read_prepared_file(file: &PreparedFile) -> Result<Vec<u8>, String> {
    match &file.source {
        PreparedSource::Inline(bytes) => Ok(bytes.clone()),
        PreparedSource::File(path) => std::fs::read(path)
            .map_err(|error| format!("无法读取诊断文件 {}：{error}", path.display())),
    }
}

fn write_json_entry<T: Serialize>(
    writer: &mut ZipWriter<File>,
    name: &str,
    value: &T,
    options: SimpleFileOptions,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("无法编码诊断包元数据 {name}：{error}"))?;
    writer
        .start_file(name, options)
        .map_err(|error| format!("无法创建诊断包条目 {name}：{error}"))?;
    writer
        .write_all(&bytes)
        .map_err(|error| format!("无法写入诊断包条目 {name}：{error}"))
}

pub fn export_bundle(
    request: DiagnosticBundleExportRequest,
) -> Result<DiagnosticBundleExportResult, String> {
    let output_path = PathBuf::from(request.output_path.trim());
    if request.output_path.trim().is_empty() {
        return Err("诊断包输出路径不能为空".to_string());
    }
    if output_path.exists() {
        return Err(format!(
            "诊断包输出文件已存在，请选择新文件名：{}",
            output_path.display()
        ));
    }
    let parent = output_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or("诊断包输出路径缺少父目录")?;
    if !parent.is_dir() {
        return Err(format!("诊断包输出目录不存在：{}", parent.display()));
    }

    let (prepared, mut records, mut warnings) = plan_export(&request)?;
    let temporary = parent.join(format!(
        ".{}.tmp-{}",
        output_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("ck-diagnostic.zip"),
        uuid::Uuid::new_v4()
    ));
    let write_result = (|| -> Result<DiagnosticBundleExportResult, String> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("无法创建诊断包临时文件：{error}"))?;
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);
        let mut total_bytes = 0u64;
        let mut included_paths = BTreeSet::new();

        for prepared_file in prepared {
            let mut bytes = read_prepared_file(&prepared_file)?;
            if bytes.len() as u64 > MAX_SINGLE_FILE_BYTES {
                warnings.push(format!(
                    "文件读取后超过大小上限，已排除：{}",
                    prepared_file.archive_path
                ));
                records.push(DiagnosticBundleFileRecord {
                    item_id: prepared_file.item_id,
                    role: prepared_file.role,
                    status: "omitted_too_large".to_string(),
                    archive_path: Some(prepared_file.archive_path),
                    source_path: prepared_file
                        .source_path
                        .as_deref()
                        .and_then(|path| source_path_for_manifest(path, &request.privacy)),
                    size: None,
                    sha256: None,
                    redacted: false,
                    note: Some("文件读取后超过单文件大小上限".to_string()),
                });
                continue;
            }
            let mut redacted = false;
            match std::str::from_utf8(&bytes) {
                Ok(text) => {
                    let output = redact_text(text, &request.privacy);
                    redacted = output != text;
                    bytes = output.into_bytes();
                }
                Err(_) if request.privacy.requires_text_redaction() => {
                    warnings.push(format!(
                        "二进制文件无法可靠隐去敏感文本，已排除：{}",
                        prepared_file.archive_path
                    ));
                    records.push(DiagnosticBundleFileRecord {
                        item_id: prepared_file.item_id,
                        role: prepared_file.role,
                        status: "omitted_unredactable_binary".to_string(),
                        archive_path: Some(prepared_file.archive_path),
                        source_path: prepared_file
                            .source_path
                            .as_deref()
                            .and_then(|path| source_path_for_manifest(path, &request.privacy)),
                        size: None,
                        sha256: None,
                        redacted: false,
                        note: Some("启用隐私处理时不打包无法检查的二进制内容".to_string()),
                    });
                    continue;
                }
                Err(_) => {}
            }
            total_bytes = total_bytes.saturating_add(bytes.len() as u64);
            if total_bytes > MAX_TOTAL_BYTES {
                return Err(format!("诊断包内容超过总大小上限 {MAX_TOTAL_BYTES} 字节"));
            }
            writer
                .start_file(&prepared_file.archive_path, options)
                .map_err(|error| {
                    format!("无法创建诊断包文件 {}：{error}", prepared_file.archive_path)
                })?;
            writer.write_all(&bytes).map_err(|error| {
                format!("无法写入诊断包文件 {}：{error}", prepared_file.archive_path)
            })?;
            included_paths.insert(prepared_file.archive_path.clone());
            records.push(DiagnosticBundleFileRecord {
                item_id: prepared_file.item_id,
                role: prepared_file.role,
                status: "included".to_string(),
                archive_path: Some(prepared_file.archive_path),
                source_path: prepared_file
                    .source_path
                    .as_deref()
                    .and_then(|path| source_path_for_manifest(path, &request.privacy)),
                size: Some(bytes.len() as u64),
                sha256: Some(hash_bytes(&bytes)),
                redacted,
                note: None,
            });
        }

        records.sort_by(|left, right| {
            left.item_id
                .cmp(&right.item_id)
                .then_with(|| left.archive_path.cmp(&right.archive_path))
        });
        warnings.sort();
        warnings.dedup();
        let context = sanitize_context(request.context.clone(), &request.privacy);
        let source_included = records
            .iter()
            .any(|record| record.status == "included" && record.role.carries_source());
        let summary = build_summary(request.content_level, &context, source_included);
        let manifest = DiagnosticBundleManifest {
            schema_version: DIAGNOSTIC_SCHEMA_VERSION,
            generated_by: "CK".to_string(),
            generated_at: Utc::now().to_rfc3339(),
            content_level: request.content_level,
            privacy: request.privacy.clone(),
            context,
            summary: summary.clone(),
            files: records.clone(),
            warnings: warnings.clone(),
            network_used: false,
            upload_performed: false,
        };
        write_json_entry(&mut writer, MANIFEST_NAME, &manifest, options)?;
        write_json_entry(&mut writer, SUMMARY_NAME, &summary, options)?;
        let mut file = writer
            .finish()
            .map_err(|error| format!("无法完成诊断包 ZIP：{error}"))?;
        file.flush()
            .map_err(|error| format!("无法刷新诊断包文件：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("无法同步诊断包文件：{error}"))?;
        drop(file);
        std::fs::rename(&temporary, &output_path)
            .map_err(|error| format!("无法安装最终诊断包：{error}"))?;

        let missing_items = records
            .iter()
            .filter(|record| record.status == "missing")
            .count();
        let omitted_items = records
            .iter()
            .filter(|record| record.status != "included" && record.status != "missing")
            .count();
        Ok(DiagnosticBundleExportResult {
            output_path: output_path.to_string_lossy().to_string(),
            included_files: included_paths.len(),
            missing_items,
            omitted_items,
            warnings,
            summary,
        })
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write_result
}

fn read_zip_json<T: for<'de> Deserialize<'de>>(
    archive: &mut ZipArchive<File>,
    name: &str,
    max_bytes: u64,
) -> Result<T, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| format!("诊断包缺少 {name}"))?;
    if entry.is_dir() || entry.size() == 0 || entry.size() > max_bytes {
        return Err(format!("诊断包条目 {name} 大小无效"));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取诊断包条目 {name}：{error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("诊断包条目 {name} JSON 无效：{error}"))
}

pub fn inspect_bundle(path: &Path) -> Result<DiagnosticBundleInspection, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("无法检查诊断包 {}：{error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("诊断包路径不是普通本地文件".to_string());
    }
    if metadata.len() == 0 || metadata.len() > MAX_TOTAL_BYTES {
        return Err("诊断包文件大小无效".to_string());
    }
    let file = File::open(path).map_err(|error| format!("无法打开诊断包：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("ZIP 结构无效：{error}"))?;
    if archive.len() > MAX_ARCHIVE_FILES + 2 {
        return Err("诊断包条目数量超过安全上限".to_string());
    }
    let mut names = HashSet::new();
    let mut total_uncompressed = 0u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("无法读取 ZIP 索引 {index}：{error}"))?;
        if entry.encrypted() {
            return Err(format!("诊断包不允许加密条目：{}", entry.name()));
        }
        let name = safe_archive_path(entry.name())?;
        if !names.insert(name.clone()) {
            return Err(format!("诊断包包含重复条目：{name}"));
        }
        if entry.size() > MAX_SINGLE_FILE_BYTES && name != MANIFEST_NAME {
            return Err(format!("诊断包条目过大：{name}"));
        }
        total_uncompressed = total_uncompressed.saturating_add(entry.size());
        if total_uncompressed > MAX_TOTAL_BYTES {
            return Err("诊断包解压后内容超过安全上限".to_string());
        }
    }
    if !names.contains(MANIFEST_NAME) || !names.contains(SUMMARY_NAME) {
        return Err("诊断包缺少必要的本地清单或中文摘要".to_string());
    }

    let manifest: DiagnosticBundleManifest =
        read_zip_json(&mut archive, MANIFEST_NAME, MAX_MANIFEST_BYTES)?;
    if manifest.schema_version != DIAGNOSTIC_SCHEMA_VERSION {
        return Err(format!("不支持的诊断包版本 {}", manifest.schema_version));
    }
    if manifest.generated_by != "CK" {
        return Err("诊断包生成者标识无效".to_string());
    }
    if manifest.network_used || manifest.upload_performed {
        return Err("诊断包清单声称使用了网络或自动上传，拒绝本地导入".to_string());
    }
    let stored_summary: DiagnosticSummaryZh =
        read_zip_json(&mut archive, SUMMARY_NAME, MAX_MANIFEST_BYTES)?;
    let source_included = manifest
        .files
        .iter()
        .any(|record| record.status == "included" && record.role.carries_source());
    let expected_summary =
        build_summary(manifest.content_level, &manifest.context, source_included);
    if manifest.summary != expected_summary || stored_summary != expected_summary {
        return Err("诊断包中文摘要与清单内容不一致".to_string());
    }

    let mut declared_paths = HashSet::new();
    let mut included_files = 0usize;
    for record in &manifest.files {
        if record.status != "included" {
            continue;
        }
        let archive_path = record
            .archive_path
            .as_deref()
            .ok_or("诊断包 included 记录缺少 archivePath")?;
        let archive_path = safe_archive_path(archive_path)?;
        if !archive_path.starts_with("files/") {
            return Err(format!("诊断包有效载荷路径不在 files/ 下：{archive_path}"));
        }
        if !declared_paths.insert(archive_path.clone()) {
            return Err(format!("诊断包清单重复声明文件：{archive_path}"));
        }
        if !names.contains(&archive_path) {
            return Err(format!("诊断包清单声明的文件缺失：{archive_path}"));
        }
        let mut entry = archive
            .by_name(&archive_path)
            .map_err(|error| format!("无法读取诊断包文件 {archive_path}：{error}"))?;
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| format!("无法校验诊断包文件 {archive_path}：{error}"))?;
        let actual_sha256 = hash_bytes(&bytes);
        if record.size != Some(bytes.len() as u64)
            || record.sha256.as_deref() != Some(actual_sha256.as_str())
        {
            return Err(format!("诊断包文件大小或 SHA-256 不匹配：{archive_path}"));
        }
        included_files += 1;
    }
    let undeclared_payload = names
        .iter()
        .filter(|name| name.starts_with("files/") && !declared_paths.contains(*name))
        .cloned()
        .collect::<Vec<_>>();
    if !undeclared_payload.is_empty() {
        return Err(format!(
            "诊断包包含未声明文件：{}",
            undeclared_payload.join(", ")
        ));
    }
    let missing_items = manifest
        .files
        .iter()
        .filter(|record| record.status == "missing")
        .count();
    Ok(DiagnosticBundleInspection {
        valid: true,
        schema_version: manifest.schema_version,
        included_files,
        missing_items,
        warnings: manifest.warnings,
        summary: expected_summary,
        network_used: false,
        upload_performed: false,
    })
}

#[tauri::command]
pub fn export_diagnostic_bundle(
    request: DiagnosticBundleExportRequest,
) -> Result<DiagnosticBundleExportResult, String> {
    export_bundle(request)
}

#[tauri::command]
pub fn inspect_diagnostic_bundle(path: String) -> Result<DiagnosticBundleInspection, String> {
    inspect_bundle(Path::new(path.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("ck-diagnostic-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("temp root");
        root
    }

    fn request(output: &Path, level: DiagnosticContentLevel) -> DiagnosticBundleExportRequest {
        DiagnosticBundleExportRequest {
            output_path: output.to_string_lossy().to_string(),
            content_level: level,
            privacy: DiagnosticPrivacyOptions::default(),
            context: DiagnosticContext {
                board_name: Some("ESP32-C6 测试板".to_string()),
                board_id: Some("c6_test".to_string()),
                core_package: Some("esp32:esp32".to_string()),
                core_version: Some("3.3.6".to_string()),
                fqbn: Some("esp32:esp32:esp32c6:FlashSize=16M".to_string()),
                flash_used_bytes: Some(930_764),
                flash_total_bytes: Some(3_145_728),
                flash_configuration: Some("16MB".to_string()),
                core_missing: false,
                failure_stage: Some("compile".to_string()),
            },
            items: Vec::new(),
        }
    }

    fn read_zip_entry(path: &Path, name: &str) -> String {
        let file = File::open(path).expect("zip");
        let mut archive = ZipArchive::new(file).expect("archive");
        let mut entry = archive.by_name(name).expect("entry");
        let mut output = String::new();
        entry.read_to_string(&mut output).expect("utf8 entry");
        output
    }

    #[test]
    fn content_levels_include_only_the_requested_source_scope() {
        let temp = temp_root("levels");
        for (index, level, expected_source, expected_count) in [
            (0, DiagnosticContentLevel::FullProject, true, 4),
            (1, DiagnosticContentLevel::GeneratedSourceOnly, true, 3),
            (2, DiagnosticContentLevel::NoSource, false, 1),
        ] {
            let output = temp.join(format!("level-{index}.zip"));
            let mut request = request(&output, level);
            request.items = vec![
                DiagnosticBundleItem {
                    id: "project".to_string(),
                    role: DiagnosticItemRole::Project,
                    archive_path: "project/main.maker".to_string(),
                    path: None,
                    content: Some("project data".to_string()),
                    required: true,
                },
                DiagnosticBundleItem {
                    id: "generated".to_string(),
                    role: DiagnosticItemRole::GeneratedSource,
                    archive_path: "source/main.ino".to_string(),
                    path: None,
                    content: Some("void setup() {}".to_string()),
                    required: true,
                },
                DiagnosticBundleItem {
                    id: "compile-source-map".to_string(),
                    role: DiagnosticItemRole::SourceMap,
                    archive_path: "ck-sourcemap.json".to_string(),
                    path: None,
                    content: Some(
                        r#"{"schema":"ck-sourcemap","version":1,"mappings":[]}"#.to_string(),
                    ),
                    required: false,
                },
                DiagnosticBundleItem {
                    id: "compile-log".to_string(),
                    role: DiagnosticItemRole::CompileLog,
                    archive_path: "logs/compile.txt".to_string(),
                    path: None,
                    content: Some("compile failed".to_string()),
                    required: false,
                },
            ];
            let exported = export_bundle(request).expect("export");
            assert_eq!(exported.included_files, expected_count);
            assert_eq!(exported.summary.source_included, expected_source);
            let inspected = inspect_bundle(&output).expect("inspect");
            assert_eq!(inspected.included_files, expected_count);
            assert_eq!(inspected.summary.source_included, expected_source);
            assert_eq!(inspected.summary.board, "ESP32-C6 测试板");
            assert_eq!(inspected.summary.core, "esp32:esp32@3.3.6");
            assert_eq!(inspected.summary.failure_stage, "编译");

            let manifest: serde_json::Value =
                serde_json::from_str(&read_zip_entry(&output, MANIFEST_NAME)).unwrap();
            let source_map_record = manifest["files"]
                .as_array()
                .unwrap()
                .iter()
                .find(|record| record["itemId"] == "compile-source-map")
                .expect("source map record");
            assert_eq!(source_map_record["role"], "source_map");
            if level == DiagnosticContentLevel::NoSource {
                assert_eq!(source_map_record["status"], "omitted_by_level");
                let file = File::open(&output).expect("zip");
                let mut archive = ZipArchive::new(file).expect("archive");
                assert!(archive.by_name("files/ck-sourcemap.json").is_err());
            } else {
                assert_eq!(source_map_record["status"], "included");
                assert!(
                    read_zip_entry(&output, "files/ck-sourcemap.json").contains("ck-sourcemap")
                );
            }
        }
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn privacy_redaction_omits_serial_binary_and_records_missing_files() {
        let temp = temp_root("privacy");
        let output = temp.join("privacy.zip");
        let username = std::env::var("USERNAME").unwrap_or_else(|_| "tester".to_string());
        let mut request = request(&output, DiagnosticContentLevel::FullProject);
        request.items = vec![
            DiagnosticBundleItem {
                id: "source".to_string(),
                role: DiagnosticItemRole::GeneratedSource,
                archive_path: "source/wifi.ino".to_string(),
                path: None,
                content: Some(format!(
                    "WiFi.begin(\"PrivateSSID\", \"PrivatePassword\");\nC:\\Users\\{username}\\secret"
                )),
                required: true,
            },
            DiagnosticBundleItem {
                id: "serial".to_string(),
                role: DiagnosticItemRole::SerialLog,
                archive_path: "logs/serial.txt".to_string(),
                path: None,
                content: Some("SECRET_SERIAL_PAYLOAD".to_string()),
                required: false,
            },
            DiagnosticBundleItem {
                id: "missing".to_string(),
                role: DiagnosticItemRole::CompileLog,
                archive_path: "logs/missing.txt".to_string(),
                path: Some(
                    temp.join("does-not-exist.txt")
                        .to_string_lossy()
                        .to_string(),
                ),
                content: None,
                required: true,
            },
        ];
        let result = export_bundle(request).expect("export");
        assert_eq!(result.included_files, 1);
        assert_eq!(result.missing_items, 1);
        assert_eq!(result.omitted_items, 1);
        let source = read_zip_entry(&output, "files/source/wifi.ino");
        assert!(!source.contains("PrivateSSID"));
        assert!(!source.contains("PrivatePassword"));
        assert!(
            !source
                .to_ascii_lowercase()
                .contains(&username.to_ascii_lowercase())
        );
        assert!(!read_zip_entry(&output, MANIFEST_NAME).contains("does-not-exist"));
        let file = File::open(&output).expect("zip");
        let mut archive = ZipArchive::new(file).expect("archive");
        assert!(archive.by_name("files/logs/serial.txt").is_err());
        let inspection = inspect_bundle(&output).expect("inspect");
        assert_eq!(inspection.missing_items, 1);
        assert!(!inspection.network_used);
        assert!(!inspection.upload_performed);
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn full_mac_is_always_redacted_even_when_optional_privacy_is_disabled() {
        let temp = temp_root("mandatory-mac-privacy");
        let output = temp.join("mac-privacy.zip");
        let mut request = request(&output, DiagnosticContentLevel::FullProject);
        request.privacy = DiagnosticPrivacyOptions {
            redact_wifi: false,
            redact_username: false,
            redact_paths: false,
            redact_serial_content: false,
        };
        request.context.board_name = Some("ESP32-C6 AA:BB:CC:DD:EE:01".to_string());
        request.items = vec![DiagnosticBundleItem {
            id: "device-AA-BB-CC-DD-EE-02".to_string(),
            role: DiagnosticItemRole::SerialLog,
            archive_path: "logs/device-AABB.CCDD.EE03.txt".to_string(),
            path: None,
            content: Some(
                concat!(
                    "colon=AA:BB:CC:DD:EE:04\n",
                    "dash=AA-BB-CC-DD-EE-05\n",
                    "dotted=AABB.CCDD.EE06\n",
                    "mac=AABBCCDDEE07\n",
                    "\"deviceMac\": \"AABBCCDDEE08\"\n",
                    "bare_identifier=AABBCCDDEE09\n"
                )
                .to_string(),
            ),
            required: true,
        }];

        let result = export_bundle(request).expect("export");
        assert_eq!(result.included_files, 1);
        let payload_path = "files/logs/device-[MAC已隐藏].txt";
        let payload = read_zip_entry(&output, payload_path);
        for full_mac in [
            "AA:BB:CC:DD:EE:04",
            "AA-BB-CC-DD-EE-05",
            "AABB.CCDD.EE06",
            "AABBCCDDEE07",
            "AABBCCDDEE08",
        ] {
            assert!(!payload.contains(full_mac), "MAC leaked: {full_mac}");
        }
        assert!(payload.contains("[MAC已隐藏]"));
        assert!(payload.contains("bare_identifier=AABBCCDDEE09"));

        let manifest = read_zip_entry(&output, MANIFEST_NAME);
        for full_mac in ["AA:BB:CC:DD:EE:01", "AA-BB-CC-DD-EE-02", "AABB.CCDD.EE03"] {
            assert!(!manifest.contains(full_mac), "manifest leaked: {full_mac}");
        }
        assert!(manifest.contains("[MAC已隐藏]"));
        let summary = read_zip_entry(&output, SUMMARY_NAME);
        assert!(!summary.contains("AA:BB:CC:DD:EE:01"));
        assert!(summary.contains("[MAC已隐藏]"));
        inspect_bundle(&output).expect("redacted bundle remains valid");
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn local_import_rejects_traversal_and_missing_manifest() {
        let temp = temp_root("unsafe");
        let path = temp.join("unsafe.zip");
        let file = File::create(&path).expect("zip file");
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("../escape.txt", SimpleFileOptions::default())
            .expect("entry");
        writer.write_all(b"bad").expect("bytes");
        writer.finish().expect("finish");
        let error = inspect_bundle(&path).expect_err("traversal rejected");
        assert!(error.contains("不安全"));

        let path = temp.join("empty.zip");
        let file = File::create(&path).expect("zip file");
        ZipWriter::new(file).finish().expect("finish");
        let error = inspect_bundle(&path).expect_err("manifest required");
        assert!(error.contains("缺少必要"));
        let _ = std::fs::remove_dir_all(temp);
    }
}
