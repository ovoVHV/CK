//! V9.0 opt-in preview host. Structured IPC results; independent artifact verification.
use super::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
#[path = "v9_protocol.rs"]
mod contract;
use contract::{validate_receipt, validate_manifest, allows_fqbn, artifact_names};
#[path = "v9_loopback.rs"]
mod loopback;
const HOST_ENGINE_VERSION: &str = "1.0.67";

tokio::task_local! { static PROJECT_ID: Option<String>; }
pub(super) fn current_project() -> Option<String> { PROJECT_ID.try_with(Clone::clone).ok().flatten() }
pub(super) async fn with_project<F: std::future::Future>(project: Option<String>, future: F) -> F::Output {
    PROJECT_ID.scope(project, future).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    enabled: bool,
    #[serde(default)]
    disabled_reason: Option<String>,
    engine_version: String,
    protocol_version: u64,
    node_path: PathBuf,
    engine_path: PathBuf,
    ninja_path: PathBuf,
    allowed_fqbns: Vec<String>,
    #[serde(default)]
    workspace_namespace: Option<String>,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    token: String,
    #[serde(flatten)]
    options: serde_json::Map<String,Value>,
}

fn digest(bytes: &[u8]) -> String { hex::encode(Sha256::digest(bytes)) }

// Windows canonicalization may return an extended-length `\\?\\` spelling.
// Keep that spelling for security checks, but pass ordinary DOS paths to Node,
// Arduino CLI and Ninja because some third-party tools reject the prefix.
fn process_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

pub(super) async fn try_compile<F, L>(
    sysroot: &Sysroot, code: &str, fqbn: &str, extra_libs: &[PathBuf], jobs: u32,
    build_signature: &str, workspace_fingerprint: Option<&str>, identity_lease: &ToolchainIdentityLease,
    clean: bool, exact_policy: CkExactReusePolicy, progress: &F, log: &L,
) -> Result<Option<(PathBuf, String)>>
where F: Fn(f32, String), L: Fn(String) {
    let Some(config_file) = std::env::var_os("CK_V9_CONFIG") else { return Ok(None) };
    let config: Config = serde_json::from_slice(&std::fs::read(config_file)?)?;
    if !config.enabled {
        log(format!("[V9] 当前使用兼容编译：{}。\n", config.disabled_reason.as_deref().unwrap_or("启动时 V9 未启用；若刚安装 Core，请完全退出 CK 后重新打开，无需卸载")));
        return Ok(None);
    }
    anyhow::ensure!(config.protocol_version == 1 && config.engine_version == "1.0.67", "V9 host configuration version mismatch");
    if !allows_fqbn(&config.allowed_fqbns, fqbn) {
        log(format!("[V9] 当前使用兼容编译：目标 {fqbn} 不在启用的平台范围内。\n"));
        return Ok(None);
    }
    log(format!("[V9] 使用原生增量引擎；完整板卡配置：{fqbn}\n"));
    anyhow::ensure!(cfg!(windows), "This graph adapter is qualified only on Windows");
    for file in [&config.node_path, &config.engine_path, &config.ninja_path] {
        anyhow::ensure!(file.is_absolute() && file.is_file(), "Native graph tool path is missing: {}", file.display());
    }
    let started = Instant::now();
    let identity_started = Instant::now();
    identity_lease.revalidate_before_external_boundary(&sysroot.root_dir, fqbn)?;
    let pre_compile_identity_ms = identity_started.elapsed().as_millis();
    let normalized = code.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let source_hash = digest(normalized.as_bytes());
    // The renderer's workspace fingerprint is a content digest and changes on
    // every edit. Only the separate project ID chooses the incremental folder;
    // source/asset/config content is still fully validated by the controller.
    let project = current_project();
    let sources=project_sources();
    let session_key = digest(&serde_json::to_vec(&json!(["ck-build-engine-v9-protocol-1", sysroot.root_dir,
        identity_lease.toolchain_key(), fqbn, project.as_deref().unwrap_or(workspace_fingerprint.unwrap_or("default")),sources.is_some()]))?);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos();
    let request_id = digest(format!("{}:{stamp}:{source_hash}", std::process::id()).as_bytes());
    let mut root = std::env::temp_dir().join("CK_Builds/v9");
    if let Some(namespace) = &config.workspace_namespace {
        anyhow::ensure!(!namespace.is_empty() && namespace.len() <= 64 && namespace.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'), "Invalid V9 workspace namespace");
        root = root.join(namespace);
    }
    let workspace = root.join("sessions").join(session_key);
    let stage = root.join("requests").join(&request_id);
    std::fs::create_dir_all(&stage)?;
    std::fs::create_dir_all(workspace.join("source/sketch"))?;
    let workspace = canonical_managed_build_directory(&workspace)
        .ok_or_else(|| anyhow::anyhow!("Native graph workspace is outside the managed build root"))?;
    let stage = canonical_managed_build_directory(&stage)
        .ok_or_else(|| anyhow::anyhow!("Native graph request staging path is outside the managed build root"))?;
    let workspace_process = process_path(&workspace);
    let stage_process = process_path(&stage);
    let source_file = stage_process.join("source.ino");
    std::fs::write(&source_file, normalized.as_bytes())?;
    let receipt_file = stage_process.join("native-graph-receipt.json");
    let mut request = json!({"sysroot":process_path(&sysroot.root_dir),"workspace":workspace_process,
        "sketchDir":workspace_process.join("source/sketch"),"sourceFile":source_file,
        "requestId":request_id,"sourceSha256":source_hash,"receiptPath":receipt_file,"fqbn":fqbn,
        "projectFiles":sources.as_ref().map(|files|files.iter().map(|(name,b)|json!({"name":name,"hex":hex::encode(b)})).collect::<Vec<_>>()),
        "cli":process_path(&bundled_arduino_cli_lexical_path(&sysroot.root_dir)),
        "cliConfig":process_path(&sysroot.root_dir.join("arduino-cli.yaml")),"ninja":process_path(&config.ninja_path),
        "libraries":extra_libs.iter().map(|path| process_path(path)).collect::<Vec<_>>(),
        "jobs":jobs.clamp(1,8),"buildSignature":build_signature,
        "forceClean":clean,"noOpReference":exact_policy==CkExactReusePolicy::Deny,"allowNoWork":true,"quiet":false});
    let direct = (fqbn.starts_with("arduino:avr:") || fqbn.starts_with("esp32:esp32:"))
        && config.options.get("bridgeReference")!=Some(&Value::Bool(true));
    let endpoint = if direct {Some(loopback::Endpoint::new(&config)?)} else {None};
    if direct {
        for key in ["noOpReference","validationReference","frontendReference","historyReference",
            "discoveryPreprocessReference","discoveryCompileReference","coldPipelineReference",
            "nativeImageReference","assetOpenReference","coldReference","avrPropertiesReference",
            "esp32PropertiesReference","directExecutionReference"] {
            if config.options.get(key)==Some(&Value::Bool(true)) {request[key]=Value::Bool(true);}
        }
        for key in ["discoveryBatchReference","coldLibraryPchReference"] {
            if let Some(Value::Bool(value))=config.options.get(key) {request[key]=Value::Bool(*value);}
        }
    }
    let request_file = stage_process.join("request.json");
    std::fs::write(&request_file, serde_json::to_vec_pretty(&request)?)?;
    current_build_cancellation_checkpoint()?;
    log(format!("[NativeGraph] Actual request {request_id}; Windows-native compiler graph.\n"));
    progress(3.0, "Preparing native incremental compilation".into());
    let (receipt,text,success) = if let Some(endpoint)=&endpoint {
        let build=endpoint.build(&request,&normalized,log);
        let result={
            tokio::pin!(build);
            let cancellation=current_build_cancellation();
            let mut rx=cancellation.as_ref().map(BuildCancellation::subscribe);
            let cancelled=async move {
                if let Some(ref mut rx)=rx {
                    if *rx.borrow() {return;}
                    if rx.wait_for(|value| *value).await.is_ok() {return;}
                }
                std::future::pending::<()>().await
            };
            tokio::pin!(cancelled);
            let mut ticks=tokio::time::interval(Duration::from_secs(5)); ticks.tick().await;
            loop {tokio::select! {
                biased;
                _=&mut cancelled => break Err(anyhow::anyhow!("{BUILD_CANCELED_MARKER}: build cancelled by user")),
                r=&mut build => break r,
                _=ticks.tick()=>log(format!("[V9 等待] 构建请求尚未结束，已用时 {} 秒。\n",started.elapsed().as_secs())),
            }}
        };
        let (receipt,text)=match result {Ok(value)=>value,Err(e)=>{endpoint.cancel(&request_id).await;return Err(e);}};
        if !text.is_empty(){log(text.clone());}
        (receipt,text,true)
    } else {
    let mut command = Command::new(&config.node_path);
    hide_window(&mut command);
    command.arg(&config.engine_path).arg("--config").arg(&request_file).current_dir(&sysroot.root_dir);
    // Existing managed execution registers the complete process tree with CK's
    // cancellation owner and drains both output pipes with bounded storage.
    let (activity_tx, mut activity_rx) = tokio::sync::mpsc::channel(64);
    let future = managed_command_output_observed(&mut command, Some(activity_tx));
    tokio::pin!(future);
    let mut ticks = tokio::time::interval(Duration::from_secs(5));
    ticks.tick().await;
    let mut last_activity = Instant::now();
    let mut activity_open = true;
    let output = loop {
        tokio::select! {
            value = &mut future => break value?,
            activity = activity_rx.recv(), if activity_open => {
                if let Some(text) = activity { last_activity = Instant::now(); log(text); }
                else { activity_open = false; }
            }
            _ = ticks.tick() => {
                if last_activity.elapsed() >= Duration::from_secs(5) {
                    log(format!("[V9 等待] 构建请求尚未结束，已用时 {} 秒；距上一条任务输出 {} 秒。\n", started.elapsed().as_secs(), last_activity.elapsed().as_secs()));
                }
            }
        }
    };
    while let Ok(text) = activity_rx.try_recv() { log(text); }
    current_build_cancellation_checkpoint()?;
    // stdout carries the structured protocol, not user-facing compiler logs.
    let text = String::from_utf8_lossy(&output.stderr).lines()
        .filter(|line| !line.starts_with("[V9 进度] "))
        .collect::<Vec<_>>().join("\n");
    // Already streamed to the UI; retained stderr is still returned as evidence.
    // The host consumes the result returned by its managed bridge process.
    // A self-checking file on disk cannot authorize a successful build.
    let receipt: Value = serde_json::from_slice(&output.stdout).context("Invalid V9 structured result")?;
    (receipt,text,output.status.success())
    };
    current_build_cancellation_checkpoint()?;
    anyhow::ensure!(receipt["requestId"] == request_id && receipt["sourceSha256"] == source_hash && receipt["fqbn"] == fqbn,
        "V9 response identity mismatch");
    anyhow::ensure!(receipt["protocolVersion"] == 1 && receipt["engineVersion"] == "1.0.67", "V9 response version mismatch");
    if receipt["success"] != true && receipt["error"]["fallbackSafe"] == true
        && matches!(receipt["error"]["code"].as_str(), Some("ENGINE_UNAVAILABLE" | "NOT_QUALIFIED")) {
        log(format!("[V9] Safe fallback to v6: {}\n", receipt["error"]["message"]));
        return Ok(None);
    }
    validate_receipt(&receipt, &request_id, &source_hash, fqbn)?;
    if let Some(files)=&sources {
        let actual=receipt["projectFiles"].as_array().context("Missing project snapshot proof")?;
        anyhow::ensure!(actual.len()==files.len()&&files.iter().all(|(name,b)|actual.iter().any(|f|f["name"]==*name&&f["sha256"]==digest(b))),"Project source identity mismatch");
    }
    anyhow::ensure!(success, "V9 bridge failed; output rejected");
    std::fs::write(&receipt_file, serde_json::to_vec_pretty(&receipt)?)?;
    log("[V9 进度] 宿主交付：独立核验固件并导出上传目录\n".into());
    let export_started = Instant::now();
    let build_root = canonical_managed_build_directory(&workspace_process.join("build"))
        .ok_or_else(|| anyhow::anyhow!("Native graph build path is outside the managed build root"))?;
    let export = stage.join("artifacts/sketch"); std::fs::create_dir_all(&export)?;
    let artifacts = validate_manifest(&receipt)?;
    for item in artifacts {
        let name = item["name"].as_str().context("Missing artifact name")?;
        let file = PathBuf::from(item["file"].as_str().context("Missing artifact path")?);
        anyhow::ensure!(file.file_name().and_then(|n| n.to_str()) == Some(name), "Artifact name differs from path");
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            for ancestor in file.ancestors() {
                anyhow::ensure!(std::fs::symlink_metadata(ancestor)?.file_attributes() & 0x400 == 0, "Reparse artifact path rejected");
            }
        }
        anyhow::ensure!(!std::fs::symlink_metadata(&file)?.file_type().is_symlink(), "Linked artifact rejected");
        let canonical = std::fs::canonicalize(&file)?;
        anyhow::ensure!(canonical.parent() == Some(build_root.as_path()), "Artifact outside native build root");
        let bytes = std::fs::read(&canonical)?;
        anyhow::ensure!(item["bytes"].as_u64() == Some(bytes.len() as u64) && item["sha256"] == digest(&bytes), "Native artifact content mismatch");
        let destination = export.join(canonical.file_name().context("Invalid artifact name")?);
        std::fs::write(&destination, &bytes)?;
        anyhow::ensure!(item["sha256"] == digest(&std::fs::read(destination)?), "Native exported artifact changed");
    }
    for name in artifact_names(fqbn)? {
        anyhow::ensure!(export.join(name).is_file(), "Native result missing uploader artifact {name}");
    }
    let artifact_export_ms = export_started.elapsed().as_millis();
    // Preserve the consumer-boundary check after every artifact has been
    // exported and validated; it also rejects a toolchain mutation during the
    // export window before the result can leave this adapter.
    let identity_started = Instant::now();
    identity_lease.revalidate_before_external_boundary(&sysroot.root_dir, fqbn)?;
    let consumer_identity_ms = identity_started.elapsed().as_millis();
    current_build_cancellation_checkpoint()?;
    std::fs::copy(&receipt_file, export.join("native-graph-receipt.json"))?;
    let host = json!({"backend":"ck-build-engine-v9","requestId":request_id,
        "sourceSha256":source_hash,"fqbn":fqbn,"buildSignature":build_signature,
        "toolchainKey":identity_lease.toolchain_key(),"worker":receipt,"endToEndMs":started.elapsed().as_millis(),
        "adapterPhases":{"transport":if direct {"host-loopback"} else {"node-bridge"},"preCompileIdentityMs":pre_compile_identity_ms,
            "artifactExportMs":artifact_export_ms,"consumerIdentityMs":consumer_identity_ms},
        "uploadTransportChanged":false});
    std::fs::write(export.join("native-graph-host-receipt.json"), serde_json::to_vec_pretty(&host)?)?;
    if let Some(endpoint)=&endpoint {endpoint.ack(&request_id,&source_hash).await?;} else {
    let ack_file = stage_process.join("export-ack.json");
    std::fs::write(&ack_file, serde_json::to_vec(&json!({"requestId":request_id,"sourceSha256":source_hash,"success":true}))?)?;
    let mut ack = Command::new(&config.node_path); hide_window(&mut ack);
    ack.arg(&config.engine_path).arg("--config").arg(&ack_file).arg("--ack").current_dir(&sysroot.root_dir);
    let ack_output = managed_command_output(&mut ack).await?;
    anyhow::ensure!(ack_output.status.success() && serde_json::from_slice::<Value>(&ack_output.stdout)?["success"] == true, "V9 export lease acknowledgement failed");
    }
    let summary = format!("[INFO] Build backend: ck-build-engine-v9 (opt-in preview)\n[Timing] Native graph end-to-end: {}ms\n{}", started.elapsed().as_millis(), text);
    progress(100.0, "Compilation complete".into());
    Ok(Some((export, summary)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receipt_binds_actual_request_and_rejects_failed_or_stale_outputs() {
        let receipt = json!({"requestId":"r","sourceSha256":"s","fqbn":"b","success":true,"protocolVersion":1,"engineVersion":"1.0.67"});
        assert!(validate_receipt(&receipt,"r","s","b").is_ok());
        for key in ["requestId","sourceSha256","fqbn"] {
            let mut changed = receipt.clone(); changed[key] = json!("stale");
            assert!(validate_receipt(&changed,"r","s","b").is_err());
        }
        let mut failed = receipt; failed["success"] = json!(false);
        assert!(validate_receipt(&failed,"r","s","b").is_err());
    }
}
