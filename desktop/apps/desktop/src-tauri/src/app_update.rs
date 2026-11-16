use std::{fs, io::Write, path::PathBuf, sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::{Duration, Instant}};
use ck_update_protocol as protocol;
use serde::Serialize;
use tauri::{Emitter, Manager, State};
#[path = "update_transport.rs"]
mod transport;

#[derive(Clone)]
struct Candidate { manifest: protocol::Manifest, envelope: String }
#[derive(Default)]
pub struct UpdateState {
    home: AtomicBool,
    busy: AtomicBool,
    cancel: AtomicBool,
    candidate: Mutex<Option<Candidate>>,
    ready: Mutex<Option<(Candidate, PathBuf)>>,
}
pub(crate) struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> { fn drop(&mut self) { self.0.store(false, Ordering::Release); } }
pub(crate) fn start(state: &UpdateState) -> Result<Busy<'_>, String> {
    if crate::app_storage::pending() { return Err("数据迁移已安排，请等待重新启动".into()); }
    if !state.home.load(Ordering::Acquire) { return Err("请返回主页检查或安装更新".into()); }
    state.busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).map_err(|_| "正在处理更新，请稍候")?;
    state.cancel.store(false, Ordering::Release);
    Ok(Busy(&state.busy))
}
fn data_dir() -> Result<PathBuf, String> {
    let dir = crate::app_storage::product_dir()?.join("updates");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?; Ok(dir)
}
fn suppressed() -> bool {
    data_dir().ok().and_then(|p| fs::read_to_string(p.join("preferences.json")).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("suppressReminders").and_then(|v| v.as_bool())).unwrap_or(false)
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Status { current_version: String, suppress_reminders: bool }
#[tauri::command]
pub fn app_update_status() -> Status { Status { current_version: env!("CARGO_PKG_VERSION").into(), suppress_reminders: suppressed() } }
#[tauri::command]
pub fn app_update_preferences(suppress_reminders: bool) -> Result<(), String> {
    fs::write(data_dir()?.join("preferences.json"), serde_json::to_vec(&serde_json::json!({"suppressReminders":suppress_reminders})).unwrap()).map_err(|e|e.to_string())
}
#[tauri::command]
pub fn app_update_home(home: bool, window: tauri::WebviewWindow, state: State<'_, UpdateState>) -> Result<(), String> {
    if window.label() != "main" { return Err("更新只允许在主窗口中操作".into()); }
    state.home.store(home, Ordering::Release);
    if !home { state.cancel.store(true, Ordering::Release); }
    Ok(())
}
fn client(timeout: u64) -> Result<reqwest::Client, String> {
    transport::client(timeout, concat!("CK/",env!("CARGO_PKG_VERSION")))
        .map_err(|e|network_error("初始化更新连接失败", &e))
}
fn network_error(operation: &str, error: &reqwest::Error) -> String {
    let hint = transport::error_hint(error);
    let details = transport::error_details(error);
    if let Ok(dir) = data_dir() {
        let diagnostic = serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"), "at": chrono::Utc::now().to_rfc3339(),
            "operation": operation, "tls": "native-tls", "hint": hint, "details": details,
            "timeout": error.is_timeout(), "connect": error.is_connect()
        });
        if let Ok(bytes) = serde_json::to_vec_pretty(&diagnostic) {
            let _ = fs::write(dir.join("last-network-error.json"), bytes);
        }
    }
    format!("{operation}：{hint}。\n详细原因：{details}")
}
#[tauri::command]
pub async fn app_update_check(manual: bool, state: State<'_, UpdateState>) -> Result<Option<protocol::Manifest>, String> {
    let _busy = start(&state)?;
    if !manual && suppressed() { return Ok(None); }
    let policy = protocol::channel()?;
    let mut response = client(15)?.get(&policy.endpoint).header("Cache-Control", "no-cache").send().await.map_err(|e|network_error("暂时无法检查更新", &e))?;
    if response.status() == reqwest::StatusCode::NO_CONTENT { return Ok(None); }
    if !response.status().is_success() { return Err(format!("更新服务暂不可用（{}）",response.status())); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| network_error("读取更新清单失败", &e))? {
        if bytes.len() + chunk.len() > protocol::MAX_MANIFEST_BYTES { return Err("更新清单过大".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let manifest = protocol::verify_manifest(&bytes, &policy)?;
    if !protocol::is_newer(&manifest, env!("CARGO_PKG_VERSION"))? { return Ok(None); }
    if state.cancel.load(Ordering::Acquire) || !state.home.load(Ordering::Acquire) { return Ok(None); }
    *state.candidate.lock().map_err(|e|e.to_string())? = Some(Candidate { manifest: manifest.clone(), envelope: String::from_utf8(bytes).map_err(|e| e.to_string())? });
    Ok(Some(manifest))
}
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
struct Progress { downloaded: u64, total: u64, stage: &'static str }
#[tauri::command]
pub fn app_update_cancel(state: State<'_, UpdateState>) { state.cancel.store(true, Ordering::Release); }
#[tauri::command]
pub async fn app_update_download(app: tauri::AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let _busy = start(&state)?;
    let candidate = state.candidate.lock().map_err(|e|e.to_string())?.clone().ok_or("请先检查更新")?;
    let dir = data_dir()?.join(uuid::Uuid::new_v4().to_string()); fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
    let partial = dir.join("setup.exe.part"); let installer = dir.join("setup.exe");
    let outcome = async {
        let mut response = client(1800)?.get(&candidate.manifest.url).send().await.map_err(|e|network_error("下载失败", &e))?;
        if !response.status().is_success() { return Err(format!("安装包下载失败（{}）",response.status())); }
        if response.content_length().is_some_and(|n|n != candidate.manifest.size) { return Err("安装包大小与发布清单不符".into()); }
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&partial).map_err(|e|e.to_string())?;
        let mut downloaded = 0u64; let mut last_event = Instant::now() - Duration::from_secs(1);
        loop {
            let chunk = {
                let next = response.chunk();
                tokio::pin!(next);
                let deadline = tokio::time::sleep(Duration::from_secs(30));
                tokio::pin!(deadline);
                loop {
                    tokio::select! {
                        result = &mut next => break result.map_err(|e|network_error("下载连接中断", &e))?,
                        _ = &mut deadline => return Err("下载连接超时，请重试".into()),
                        _ = tokio::time::sleep(Duration::from_millis(100)) => {
                            if state.cancel.load(Ordering::Acquire) || !state.home.load(Ordering::Acquire) { return Err("已取消下载".into()); }
                        }
                    }
                }
            };
            let Some(chunk) = chunk else { break; };
            if state.cancel.load(Ordering::Acquire) || !state.home.load(Ordering::Acquire) { return Err("已取消下载".into()); }
            downloaded += chunk.len() as u64;
            if downloaded > candidate.manifest.size { return Err("下载内容超过发布清单大小".into()); }
            file.write_all(&chunk).map_err(|e|e.to_string())?;
            if last_event.elapsed() >= Duration::from_millis(100) {
                let _ = app.emit("app-update-progress",Progress{downloaded,total:candidate.manifest.size,stage:"downloading"}); last_event=Instant::now();
            }
        }
        file.sync_all().map_err(|e|e.to_string())?; drop(file);
        if state.cancel.load(Ordering::Acquire) { return Err("已取消下载".into()); }
        let _ = app.emit("app-update-progress",Progress{downloaded,total:candidate.manifest.size,stage:"verifying"});
        let verify_path=partial.clone(); let m=candidate.manifest.clone();
        tauri::async_runtime::spawn_blocking(move || protocol::open_verified_package(&verify_path,&m).map(drop)).await.map_err(|e|e.to_string())??;
        if state.cancel.load(Ordering::Acquire) || !state.home.load(Ordering::Acquire) { return Err("已取消下载".into()); }
        fs::rename(&partial,&installer).map_err(|e|e.to_string())?;
        *state.ready.lock().map_err(|e|e.to_string())? = Some((candidate,installer));
        Ok(())
    }.await;
    if outcome.is_err() { let _=fs::remove_file(&partial); let _=fs::remove_dir(&dir); }
    outcome
}

#[tauri::command]
pub async fn app_update_install(app: tauri::AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let _busy=start(&state)?;
    if !app.state::<crate::ForegroundBuildState>().registry.lock().map_err(|e|e.to_string())?.active.is_empty()
        || app.state::<crate::UploadState>().inner.session.lock().map_err(|e|e.to_string())?.is_some() {
        return Err("请等待编译或上传完成后再升级".into());
    }
    let (candidate,installer)=state.ready.lock().map_err(|e|e.to_string())?.clone().ok_or("请先下载并验证更新")?;
    let request_path=std::env::var_os("CK_UPDATE_REQUEST_PATH").map(PathBuf::from).ok_or("请从 CK 启动器启动软件后更新")?;
    let exe=std::env::current_exe().map_err(|e|e.to_string())?;
    let root=exe.parent().and_then(|p|p.parent()).ok_or("安装目录无效")?;
    if fs::read_to_string(root.join("package-id.txt")).unwrap_or_default().trim()!=protocol::PACKAGE_MARKER
        || !root.join("engine/bin/update-helper.exe").is_file() { return Err("当前安装不支持自动升级，请使用完整安装包".into()) }
    let request=protocol::InstallRequest{schema:1,install_root:root.to_string_lossy().into_owned(),installer:installer.to_string_lossy().into_owned(),envelope:candidate.envelope,current_version:env!("CARGO_PKG_VERSION").into()};
    let mut f=fs::OpenOptions::new().write(true).create_new(true).open(request_path).map_err(|e|format!("无法安排升级：{e}"))?;
    f.write_all(&serde_json::to_vec(&request).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?; f.sync_all().map_err(|e|e.to_string())?;
    // app.exit runs the existing task shutdown coordinator; bootstrap then
    // drains its controller, and only the launcher starts the installer helper.
    tauri::async_runtime::spawn(async move { tokio::time::sleep(Duration::from_millis(400)).await; app.exit(0); });
    Ok(())
}
