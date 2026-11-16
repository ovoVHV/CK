use crate::ipc_error::ErrorDescriptor;
use serde::Serialize;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

pub const PROJECT_OPEN_EVENT: &str = "ck-project-open-requested";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenRequest {
    pub request_id: String,
    pub path: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenTarget {
    pub path: String,
    pub name: String,
}

#[derive(Default)]
pub struct ProjectOpenState {
    pending: Mutex<VecDeque<ProjectOpenRequest>>,
}

impl ProjectOpenState {
    pub fn from_launch_args<I>(args: I, cwd: &Path) -> Self
    where
        I: IntoIterator<Item = OsString>,
    {
        let state = Self::default();
        let strings = args
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        for path in project_paths_from_args(&strings, cwd) {
            state.enqueue(path, "cold-start");
        }
        state
    }

    fn enqueue(&self, path: PathBuf, source: &str) -> ProjectOpenRequest {
        let request = ProjectOpenRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            path: display_path(&path),
            source: source.to_string(),
        };
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Every item in this queue represents an explicit OS/user open action.
        // Keep requests durable until the frontend acknowledges them; evicting
        // an older item here can silently open the wrong project after a burst
        // of double-clicks or second-instance launches.
        pending.push_back(request.clone());
        request
    }

    fn pending_requests(&self) -> Vec<ProjectOpenRequest> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    fn acknowledge(&self, request_id: &str) {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|request| request.request_id != request_id);
    }
}

fn strip_wrapping_quotes(value: &str) -> &str {
    let trimmed = value.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    }
}

fn deep_link_project_path(value: &str) -> Option<PathBuf> {
    let url = Url::parse(value).ok()?;
    if url.scheme().eq_ignore_ascii_case("file") {
        return url.to_file_path().ok();
    }
    if !url.scheme().eq_ignore_ascii_case("ck") {
        return None;
    }
    url.query_pairs()
        .find(|(key, _)| key.eq_ignore_ascii_case("path"))
        .map(|(_, path)| PathBuf::from(path.into_owned()))
}

fn is_supported_project_extension(extension: &str) -> bool {
    extension.eq_ignore_ascii_case("ck") || extension.eq_ignore_ascii_case("maker")
}

fn project_path_from_arg(value: &str, cwd: &Path) -> Option<PathBuf> {
    let value = strip_wrapping_quotes(value);
    if value.is_empty() || value.starts_with('-') {
        return None;
    }
    let path = deep_link_project_path(value).unwrap_or_else(|| PathBuf::from(value));
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    if !is_supported_project_extension(extension) {
        return None;
    }
    Some(if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    })
}

fn project_paths_from_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for arg in args {
        if let Some(path) = project_path_from_arg(arg, cwd) {
            if !paths.iter().any(|existing| existing == &path) {
                paths.push(path);
            }
        }
    }
    paths
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", rest);
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value.into_owned()
}

fn normalize_existing_project_path(raw_path: &str) -> Result<PathBuf, ErrorDescriptor> {
    let raw_path = strip_wrapping_quotes(raw_path);
    if raw_path.is_empty() {
        return Err(ErrorDescriptor::new(
            "PROJECT_PATH_EMPTY",
            "工程路径为空，无法打开。",
        ));
    }
    let supplied = PathBuf::from(raw_path);
    let absolute = if supplied.is_absolute() {
        supplied
    } else {
        std::env::current_dir()
            .map_err(|error| {
                ErrorDescriptor::new(
                    "PROJECT_PATH_RESOLVE_FAILED",
                    format!("无法解析工程路径：{error}"),
                )
                .with_raw_cause(error.to_string())
            })?
            .join(supplied)
    };
    fs::canonicalize(&absolute).map_err(|error| {
        let path = display_path(&absolute);
        if error.kind() == std::io::ErrorKind::NotFound {
            ErrorDescriptor::new(
                "PROJECT_NOT_FOUND",
                format!("工程路径无效或文件已被移动：{}", absolute.display()),
            )
            .with_param("path", path)
            .with_raw_cause(error.to_string())
        } else if error.kind() == std::io::ErrorKind::PermissionDenied {
            ErrorDescriptor::new(
                "PROJECT_ACCESS_DENIED",
                format!("没有权限访问该工程：{}", absolute.display()),
            )
            .with_param("path", path)
            .with_raw_cause(error.to_string())
        } else {
            ErrorDescriptor::new(
                "PROJECT_PATH_UNAVAILABLE",
                format!("无法访问工程 '{}': {error}", absolute.display()),
            )
            .with_param("path", path)
            .with_raw_cause(error.to_string())
        }
    })
}

fn validate_project_open_document(path: &Path) -> Result<(), ErrorDescriptor> {
    const CK_PROJECT_FORMAT: &str = "ck-project";
    const CK_PROJECT_SCHEMA_VERSION: u64 = 1;
    const CK_PROJECT_MIGRATION_VERSION: u64 = 1;

    let source = fs::read_to_string(path).map_err(|error| {
        ErrorDescriptor::new("PROJECT_READ_FAILED", format!("无法读取工程文件：{error}"))
            .with_param("path", display_path(path))
            .with_raw_cause(error.to_string())
    })?;
    let parsed: serde_json::Value = serde_json::from_str(&source).map_err(|error| {
        ErrorDescriptor::new(
            "PROJECT_JSON_INVALID",
            format!("工程文件已损坏或内容不完整：{error}"),
        )
        .with_param("path", display_path(path))
        .with_raw_cause(error.to_string())
    })?;
    let root = parsed.as_object().ok_or_else(|| {
        ErrorDescriptor::new(
            "PROJECT_DOCUMENT_INVALID",
            "工程文件已损坏或内容不完整：工程根节点必须是 JSON 对象",
        )
        .with_param("path", display_path(path))
        .with_raw_cause("CK project root must be a JSON object")
    })?;

    let identity_fields = ["format", "schema_version", "migration_version"];
    let identity_presence = identity_fields
        .iter()
        .filter(|field| root.contains_key(**field))
        .count();
    if identity_presence != 0 && identity_presence != identity_fields.len() {
        return Err(ErrorDescriptor::new(
            "PROJECT_DOCUMENT_INVALID",
            "工程文件已损坏或内容不完整：工程格式身份字段不完整",
        )
        .with_param("path", display_path(path))
        .with_raw_cause("format, schema_version and migration_version must appear together"));
    }
    if identity_presence == identity_fields.len() {
        let format = root.get("format").and_then(serde_json::Value::as_str);
        let schema_version = root
            .get("schema_version")
            .and_then(serde_json::Value::as_u64);
        let migration_version = root
            .get("migration_version")
            .and_then(serde_json::Value::as_u64);
        if format != Some(CK_PROJECT_FORMAT)
            || schema_version != Some(CK_PROJECT_SCHEMA_VERSION)
            || migration_version != Some(CK_PROJECT_MIGRATION_VERSION)
        {
            return Err(ErrorDescriptor::new(
                "PROJECT_VERSION_UNSUPPORTED",
                "工程版本不兼容：当前 CK 无法打开该工程格式版本",
            )
            .with_param("format", format.unwrap_or("(non-string)").to_string())
            .with_param(
                "schemaVersion",
                schema_version
                    .map(serde_json::Value::from)
                    .unwrap_or(serde_json::Value::Null),
            )
            .with_param(
                "migrationVersion",
                migration_version
                    .map(serde_json::Value::from)
                    .unwrap_or(serde_json::Value::Null),
            ));
        }
    }

    super::project::validate_external_project_document(path).map_err(|raw_cause| {
        ErrorDescriptor::new(
            "PROJECT_DOCUMENT_INVALID",
            format!("工程文件已损坏或内容不完整：{raw_cause}"),
        )
        .with_param("path", display_path(path))
        .with_raw_cause(raw_cause)
    })
}

pub fn handle_second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }

    let cwd = PathBuf::from(cwd);
    let state = app.state::<ProjectOpenState>();
    for path in project_paths_from_args(&args, &cwd) {
        let request = state.enqueue(path, "second-instance");
        if let Err(error) = app.emit_to("main", PROJECT_OPEN_EVENT, request) {
            log::warn!("[PROJECT OPEN] Failed to emit second-instance request: {error}");
        }
    }
}

#[tauri::command]
pub fn drain_pending_project_opens(state: State<'_, ProjectOpenState>) -> Vec<ProjectOpenRequest> {
    // Despite the legacy command name, this is intentionally a snapshot.
    // A request remains durable until the frontend finishes the unsaved-work
    // decision and calls `acknowledge_project_open`.
    state.pending_requests()
}

#[tauri::command]
pub fn acknowledge_project_open(state: State<'_, ProjectOpenState>, request_id: String) {
    state.acknowledge(request_id.trim());
}

#[tauri::command]
pub fn prepare_project_open(path: String) -> Result<ProjectOpenTarget, String> {
    prepare_project_open_v2(path).map_err(ErrorDescriptor::into_legacy_message)
}

/// Machine-readable companion to the legacy `prepare_project_open` command.
/// The old command remains registered so older callers keep receiving the
/// exact human-readable `message` contract.
#[tauri::command]
pub fn prepare_project_open_v2(path: String) -> Result<ProjectOpenTarget, ErrorDescriptor> {
    let canonical = normalize_existing_project_path(&path)?;
    if !canonical.is_file() {
        return Err(ErrorDescriptor::new(
            "PROJECT_NOT_FILE",
            format!("目标不是 CK 工程文件：{}", canonical.display()),
        )
        .with_param("path", display_path(&canonical)));
    }
    let extension = canonical
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    if !is_supported_project_extension(extension) {
        return Err(ErrorDescriptor::new(
            "PROJECT_EXTENSION_UNSUPPORTED",
            format!(
                "文件类型不受支持，请选择 .ck 或 .maker 工程：{}",
                canonical.display()
            ),
        )
        .with_param("path", display_path(&canonical))
        .with_param("extension", extension.to_string()));
    }
    validate_project_open_document(&canonical)?;
    let name = canonical
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("CK 工程")
        .to_string();
    Ok(ProjectOpenTarget {
        path: display_path(&canonical),
        name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_absolute_relative_quoted_and_deep_link_project_paths() {
        let cwd = Path::new(r"C:\Users\Student\Projects");
        let args = vec![
            "CK.exe".to_string(),
            r#""D:\课堂工程\Blink Demo.ck""#.to_string(),
            "relative.ck".to_string(),
            "legacy.maker".to_string(),
            "ck://open?path=E%3A%5CProjects%5Csensor.ck".to_string(),
            "--ignored".to_string(),
            "notes.txt".to_string(),
        ];
        let paths = project_paths_from_args(&args, cwd);
        assert_eq!(paths.len(), 4);
        assert_eq!(paths[0], PathBuf::from(r"D:\课堂工程\Blink Demo.ck"));
        assert_eq!(paths[1], cwd.join("relative.ck"));
        assert_eq!(paths[2], cwd.join("legacy.maker"));
        assert_eq!(paths[3], PathBuf::from(r"E:\Projects\sensor.ck"));
    }

    #[test]
    fn launch_state_deduplicates_paths_and_retains_until_acknowledged() {
        let cwd = Path::new(r"C:\Projects");
        let state = ProjectOpenState::from_launch_args(
            [
                OsString::from("CK.exe"),
                OsString::from("demo.ck"),
                OsString::from("demo.ck"),
            ],
            cwd,
        );
        let pending = state.pending_requests();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].path, display_path(&cwd.join("demo.ck")));
        assert_eq!(state.pending_requests(), pending);
        state.acknowledge(&pending[0].request_id);
        assert!(state.pending_requests().is_empty());
    }

    #[test]
    fn durable_queue_does_not_drop_bursts_before_acknowledgement() {
        let state = ProjectOpenState::default();
        for index in 0..32 {
            state.enqueue(
                PathBuf::from(format!(r"C:\Projects\burst-{index}.ck")),
                "second-instance",
            );
        }

        let pending = state.pending_requests();
        assert_eq!(pending.len(), 32);
        assert!(pending.first().unwrap().path.ends_with("burst-0.ck"));
        assert!(pending.last().unwrap().path.ends_with("burst-31.ck"));
    }

    #[test]
    fn preflight_rejects_missing_and_future_schema_projects() {
        let sandbox = tempfile::tempdir().unwrap();
        let missing = sandbox.path().join("missing.ck");
        assert!(prepare_project_open(display_path(&missing))
            .unwrap_err()
            .contains("路径无效"));

        let future = sandbox.path().join("future.ck");
        fs::write(
            &future,
            r#"{"format":"ck-project","schema_version":999,"migration_version":1,"name":"future","board":"Arduino Uno","xml":""}"#,
        )
        .unwrap();
        assert!(prepare_project_open(display_path(&future))
            .unwrap_err()
            .contains("版本不兼容"));
        let typed = prepare_project_open_v2(display_path(&future)).unwrap_err();
        assert_eq!(typed.code, "PROJECT_VERSION_UNSUPPORTED");
        assert_eq!(typed.params["schemaVersion"], serde_json::Value::from(999));
        assert!(typed.raw_cause.is_none());

        let legacy = sandbox.path().join("legacy.maker");
        fs::write(
            &legacy,
            r#"{"name":"legacy","board":"Arduino Uno","xml":""}"#,
        )
        .unwrap();
        let target = prepare_project_open(display_path(&legacy)).unwrap();
        assert_eq!(target.name, "legacy");
        assert!(target.path.ends_with("legacy.maker"));
    }

    #[test]
    fn typed_open_errors_keep_code_params_message_and_raw_cause_separate() {
        let sandbox = tempfile::tempdir().unwrap();
        let corrupt = sandbox.path().join("corrupt.ck");
        fs::write(&corrupt, "{not-json").unwrap();
        let error = prepare_project_open_v2(display_path(&corrupt)).unwrap_err();
        assert_eq!(error.code, "PROJECT_JSON_INVALID");
        assert_eq!(error.params["path"], display_path(&corrupt));
        assert!(error.message.contains("工程文件已损坏"));
        assert!(error
            .raw_cause
            .as_deref()
            .is_some_and(|cause| cause.contains("line 1")));
    }
}
