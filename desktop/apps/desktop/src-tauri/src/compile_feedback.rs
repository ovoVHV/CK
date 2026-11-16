//! Optional, user-initiated diagnostics. Never network or disk I/O on the build path.
//! The host retains immutable finished-run snapshots; the WebView cannot supply a log.
use std::{collections::VecDeque, sync::{Arc, Mutex}, time::Instant};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

const ENDPOINT: &str = "https://ckswitch.site/ck-feedback/v1";
const MAX_LOG_BYTES: usize = 240 * 1024;
const MAX_RAW_BYTES: usize = 512 * 1024;

#[derive(Default)]
pub struct FeedbackState(Mutex<VecDeque<Run>>);
struct Run {
    run_id: String,
    report_id: String,
    fqbn: String,
    outcome: String,
    elapsed_ms: u64,
    created_at: String,
    raw: String,
    prepared: Option<String>,
    submitting: bool,
    receipt: Option<Receipt>,
}

pub struct Capture {
    app: AppHandle,
    run_id: String,
    fqbn: String,
    trace: Arc<Mutex<crate::CompileDiagnosticTrace>>,
    started: Instant,
    outcome: &'static str,
}
impl Capture {
    pub fn new(app: &AppHandle, run_id: &str, fqbn: &str, trace: Arc<Mutex<crate::CompileDiagnosticTrace>>) -> Self {
        Self { app: app.clone(), run_id: run_id.into(), fqbn: fqbn.into(), trace,
            started: Instant::now(), outcome: "failed-or-cancelled" }
    }
    pub fn success(&mut self) { self.outcome = "success"; }
}
impl Drop for Capture {
    fn drop(&mut self) {
        let Ok(trace) = self.trace.lock() else { return; };
        let mut raw = trace.rendered();
        // Keep the final timing evidence when very verbose compiler output was emitted.
        if raw.len() > MAX_RAW_BYTES {
            let mut start = raw.len() - MAX_RAW_BYTES;
            while !raw.is_char_boundary(start) { start += 1; }
            raw = format!("[INFO] Earlier log omitted (size limit).\n{}", &raw[start..]);
        }
        let state = self.app.state::<FeedbackState>();
        let Ok(mut runs) = state.0.lock() else { return; };
        // A run cannot be re-registered to clear a submitted state.
        if runs.iter().any(|r| r.run_id == self.run_id) { return; }
        if runs.len() >= 8 {
            if let Some(index) = runs.iter().position(|r| !r.submitting) { runs.remove(index); }
            else { return; }
        }
        runs.push_back(Run { run_id: self.run_id.clone(), report_id: uuid::Uuid::new_v4().to_string(),
            fqbn: self.fqbn.clone(), outcome: self.outcome.into(), elapsed_ms: self.started.elapsed().as_millis() as u64,
            created_at: chrono::Utc::now().to_rfc3339(), raw, prepared: None, submitting: false, receipt: None });
    }
}

// Do not transmit arbitrary compiler output: source excerpts, commands and upload/
// serial content are excluded. Retained engine diagnostics have quotes, paths,
// secret assignments, network addresses and token forms removed as a second layer.
pub(crate) fn sanitize(input: &str) -> (String, usize) {
    use regex::Regex;
    let allowed = Regex::new(r"^\[(?:Timing[^\]]*|V9|INFO|信息|DIAG|WARN|ERROR|NativeGraph|NativeGraph[^\]]*)\]").unwrap();
    let quoted = Regex::new(r#"\"[^\"\r\n]*\"|'[^'\r\n]*'"#).unwrap();
    let path = Regex::new(r#"(?i)(?:\\\\\?\\)?[a-z]:[\\/][^\r\n]*|\\\\[^\s]+|/(?:home|Users|tmp|var)/[^\r\n]*"#).unwrap();
    let secret = Regex::new(r"(?i)\b(?:api[_-]?key|access[_-]?token|authorization|password|passwd|passphrase|ssid|secret)\b\s*[:=].*").unwrap();
    let token = Regex::new(r"(?i)\b(?:sk-|ghp_|github_pat_)[a-z0-9_-]+|Bearer\s+\S+|https?://\S+").unwrap();
    let address = Regex::new(r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b|\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b").unwrap();
    let mut lines = VecDeque::new();
    let mut bytes = 0;
    let mut omitted = 0;
    for line in input.lines() {
        if !allowed.is_match(line) { omitted += 1; continue; }
        let line = secret.replace_all(line, "[secret removed]");
        let line = quoted.replace_all(&line, "[quoted text removed]");
        let line = path.replace_all(&line, "[local path removed]");
        let line = token.replace_all(&line, "[token or URL removed]");
        let line = address.replace_all(&line, "[network address removed]");
        let line: String = line.chars().filter(|c| !c.is_control() || *c == '\t').take(4096).collect();
        bytes += line.len() + 1;
        lines.push_back(line);
        while bytes > MAX_LOG_BYTES {
            if let Some(old) = lines.pop_front() { bytes -= old.len() + 1; omitted += 1; }
        }
    }
    (lines.into_iter().collect::<Vec<_>>().join("\n"), omitted)
}

fn prepare(run: &mut Run) -> String {
    run.prepared.get_or_insert_with(|| {
        let (log, omitted) = sanitize(&run.raw);
        let fqbn: String = run.fqbn.chars().filter(|c| c.is_ascii_alphanumeric() || "_:,=.+-".contains(*c)).take(512).collect();
        serde_json::json!({ "schema": 1, "reportId": run.report_id, "appVersion": env!("CARGO_PKG_VERSION"),
            "createdAt": run.created_at, "fqbn": fqbn, "outcome": run.outcome,
            "elapsedMs": run.elapsed_ms, "logicalCpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
            "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "omittedLines": omitted, "log": log }).to_string()
    }).clone()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt { pub report_id: String, pub received_at: String }

#[tauri::command]
pub fn preview_compile_feedback(state: State<'_, FeedbackState>, run_id: String) -> Result<serde_json::Value, String> {
    let mut runs = state.0.lock().map_err(|_| "日志状态暂不可用")?;
    let run = runs.iter_mut().find(|r| r.run_id == run_id).ok_or("本次编译日志不可提交：构建尚未结束、未启动，或已过期。可以复制输出日志。")?;
    let payload = prepare(run);
    Ok(serde_json::json!({ "report": serde_json::from_str::<serde_json::Value>(&payload).unwrap(),
        "receipt": run.receipt, "submitting": run.submitting }))
}

// A stable anonymous identifier limits one installation. It is not authentication.
fn installation_id(app: &AppHandle) -> Result<String, String> {
    use std::io::Write;
    let root = crate::app_storage::desktop_dir(app).map_err(|_| "无法读取本机反馈设置")?;
    std::fs::create_dir_all(&root).map_err(|_| "无法建立本机反馈设置")?;
    let path = root.join("feedback-installation-id");
    if let Ok(id) = std::fs::read_to_string(&path) {
        if uuid::Uuid::parse_str(id.trim()).is_ok() { return Ok(id.trim().into()); }
        return Err("本机反馈标识损坏，请联系 CK LAB".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => { file.write_all(id.as_bytes()).map_err(|_| "无法保存本机反馈设置")?; Ok(id) }
        Err(_) => std::fs::read_to_string(&path).map(|s| s.trim().into()).map_err(|_| "无法保存本机反馈设置".into()),
    }
}

async fn json_response(response: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            429 => "提交较频繁，请一小时后重试；已提交的编译不会重复保存。",
            413 => "日志超过服务器大小限制，请使用复制日志。",
            409 => "本次编译已提交，服务器拒绝修改或重复保存。",
            503 => "日志服务暂不可用或存储已满，请稍后重试。",
            _ => "日志服务尚未就绪或请求被拒绝，请稍后重试。",
        }.into());
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取日志服务响应失败")? {
        if bytes.len() + chunk.len() > 8192 { return Err("日志服务响应异常".into()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "日志服务响应格式错误".into())
}

fn solve(ticket: &str, difficulty: u32) -> Result<u64, String> {
    if !(12..=22).contains(&difficulty) || ticket.len() > 2048 { return Err("日志服务校验要求异常".into()); }
    let started = Instant::now();
    for nonce in 0u64.. {
        let hash = Sha256::digest(format!("{ticket}:{nonce}"));
        let value = u32::from_be_bytes(hash[..4].try_into().unwrap());
        if value.leading_zeros() >= difficulty { return Ok(nonce); }
        if nonce % 16384 == 0 && started.elapsed().as_secs() >= 10 { break; }
    }
    Err("防滥用校验超时，请稍后重试".into())
}

async fn send(app: &AppHandle, payload: String, report_id: &str) -> Result<Receipt, String> {
    let install = installation_id(app)?;
    let digest = hex::encode(Sha256::digest(payload.as_bytes()));
    let client = reqwest::Client::builder().https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30)).user_agent("CK-Compile-Feedback/1")
        .build().map_err(|_| "无法创建 HTTPS 连接")?;
    let challenge = json_response(client.post(format!("{ENDPOINT}/challenge"))
        .json(&serde_json::json!({ "reportId": report_id, "digest": digest, "installationId": install }))
        .send().await.map_err(|_| "无法连接日志服务器，请检查网络后重试；本次日志尚未标记为已提交。")?).await?;
    if let Some(receipt) = challenge.get("receipt") {
        let receipt: Receipt = serde_json::from_value(receipt.clone()).map_err(|_| "日志回执无效")?;
        if receipt.report_id != report_id { return Err("日志回执身份不匹配".into()); }
        return Ok(receipt);
    }
    let ticket = challenge["ticket"].as_str().ok_or("缺少日志校验凭据")?.to_owned();
    let difficulty = challenge["difficulty"].as_u64().ok_or("缺少日志校验参数")?;
    if difficulty > 22 { return Err("日志校验难度异常".into()); }
    let work_ticket = ticket.clone();
    let nonce = tauri::async_runtime::spawn_blocking(move || solve(&work_ticket, difficulty as u32))
        .await.map_err(|_| "日志校验任务失败")??;
    let response = json_response(client.post(format!("{ENDPOINT}/reports"))
        .json(&serde_json::json!({ "ticket": ticket, "nonce": nonce, "payload": payload }))
        .send().await.map_err(|_| "未收到服务器确认；可重试查询，本次编译不会重复保存。")?).await?;
    let receipt: Receipt = serde_json::from_value(response["receipt"].clone()).map_err(|_| "日志回执无效")?;
    if receipt.report_id != report_id { return Err("日志回执身份不匹配".into()); }
    Ok(receipt)
}

#[tauri::command]
pub async fn submit_compile_feedback(app: AppHandle, run_id: String) -> Result<Receipt, String> {
    let (payload, report_id) = {
        let state = app.state::<FeedbackState>();
        let mut runs = state.0.lock().map_err(|_| "日志状态暂不可用")?;
        let run = runs.iter_mut().find(|r| r.run_id == run_id).ok_or("本次编译日志已过期")?;
        if let Some(receipt) = &run.receipt { return Ok(receipt.clone()); }
        if run.submitting { return Err("本次编译日志正在提交，请勿重复点击".into()); }
        run.submitting = true;
        (prepare(run), run.report_id.clone())
    };
    let result = send(&app, payload, &report_id).await;
    let state = app.state::<FeedbackState>();
    if let Ok(mut runs) = state.0.lock() {
        if let Some(run) = runs.iter_mut().find(|r| r.run_id == run_id) {
            run.submitting = false;
            if let Ok(receipt) = &result { run.receipt = Some(receipt.clone()); }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_timings_without_source_credentials_or_paths() {
        let (log, omitted) = sanitize("[Timing] V9 link=7.5s\n[INFO] Path: \\?\\C:\\Users\\PrivateName\\foo\n[INFO] password=topsecret\n[INFO] WiFi.begin(\"my-net\", \"my-pass\");\n[DIAG] api_key=sk-secret\n  5 | Serial.println(\"secret-source\");\nxtensa-g++ C:\\Users\\name\\foo.cpp\n[INFO] sk-123ABCabc https://secret.invalid/?token=123\n");
        assert!(log.contains("link=7.5s"));
        for value in ["PrivateName", "topsecret", "my-net", "my-pass", "sk-secret", "secret-source", "xtensa-g++", "sk-123", "secret.invalid"] { assert!(!log.contains(value), "{value}"); }
        assert_eq!(omitted, 2);
    }
    #[test]
    fn bounded_unicode_retains_final_timings() {
        let input = format!("{}\n[Timing] final=3s", "[INFO] 汉".repeat(100000));
        let (log, _) = sanitize(&input);
        assert!(log.len() <= MAX_LOG_BYTES);
        assert!(log.ends_with("final=3s"));
    }
    #[test]
    fn proof_of_work_has_required_prefix_and_bounded_difficulty() {
        let nonce = solve("test-ticket", 12).unwrap();
        let hash = Sha256::digest(format!("test-ticket:{nonce}"));
        assert!(u32::from_be_bytes(hash[..4].try_into().unwrap()).leading_zeros() >= 12);
        assert!(solve("test", 31).is_err());
    }
}
